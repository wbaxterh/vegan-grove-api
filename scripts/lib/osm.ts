/**
 * Shared OpenStreetMap plumbing for the place importers: the Overpass fetch,
 * the tag-to-field mapping, and the run loop that hands mapped items to the
 * ingest service in batches. Both `seed-places-osm.ts` and
 * `seed-places-gardens.ts` are thin wrappers over this file.
 */
import { config as loadDotenv } from 'dotenv';
import { loadEnv } from '../../src/config/env.js';
import { connectDb, disconnectDb } from '../../src/db/mongoose.js';
import { areaForPoint } from '../../src/lib/areas.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import { describePlace } from '../../src/lib/placeDescription.js';
import { PlaceModel, type PlaceType, type VeganLevel } from '../../src/models/index.js';
import { type IngestResult, ingestItems, type PlaceItem } from '../../src/services/ingest.js';

/** South of Santa Barbara, north of the border, west of the desert: s,w,n,e for Overpass. */
export const SOCAL_BBOX = '32.5,-119.5,34.9,-116.0';
export const OSM_USER_AGENT = 'vegan-grove-seed/0.2 (+https://vegangrove.org)';
export const OSM_SOURCE = 'osm';
const BATCH_SIZE = 200;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export async function fetchOverpass(url: string, query: string): Promise<OverpassElement[]> {
  const res = await fetch(`${url}?data=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': OSM_USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { elements?: OverpassElement[] };
  return body.elements ?? [];
}

export const osmSourceId = (el: OverpassElement) => `${el.type}/${el.id}`;
export const osmUrl = (el: OverpassElement) => `https://www.openstreetmap.org/${el.type}/${el.id}`;

export function elementPoint(el: OverpassElement): { lng: number; lat: number } | null {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  return lat === undefined || lng === undefined ? null : { lng, lat };
}

/** OSM `yes` flags that become tags on the place card. */
const FEATURE_TAGS: Array<[string, string]> = [
  ['wheelchair', 'wheelchair'],
  ['outdoor_seating', 'outdoor-seating'],
  ['takeaway', 'takeaway'],
  ['delivery', 'delivery'],
];

export function cuisineTags(tags: Record<string, string>): string[] {
  return (tags.cuisine ?? '')
    .split(';')
    .map((c) => c.trim().toLowerCase().replace(/_/g, '-'))
    .filter(Boolean);
}

function featureTags(tags: Record<string, string>): string[] {
  return FEATURE_TAGS.filter(([key]) => tags[key] === 'yes').map(([, tag]) => tag);
}

function optionalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(';')[0]?.trim() ?? '';
  const withScheme = /^https?:\/\//i.test(first) ? first : `https://${first}`;
  try {
    return new URL(withScheme).toString().slice(0, 500);
  } catch {
    return undefined;
  }
}

export interface MapOptions {
  type: PlaceType;
  veganLevel: VeganLevel;
  /** Tags added ahead of the cuisine and feature tags, e.g. `community-garden`. */
  extraTags?: string[];
}

/**
 * One Overpass element to one ingest item. Returns null when the element has
 * no name or no position. Area comes from the coordinates; city falls back to
 * the area label inside the ingest service when `addr:city` is missing.
 */
export function toPlaceItem(el: OverpassElement, options: MapOptions): PlaceItem | null {
  const tags = el.tags ?? {};
  const name = tags.name?.trim();
  const point = elementPoint(el);
  if (!name || !point) return null;

  const cuisine = cuisineTags(tags);
  const city = tags['addr:city']?.trim();
  const address = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const allTags = Array.from(
    new Set([OSM_SOURCE, ...(options.extraTags ?? []), ...cuisine, ...featureTags(tags)]),
  ).slice(0, 30);
  const description =
    tags.description?.trim().slice(0, 2000) ||
    describePlace({
      type: options.type,
      veganLevel: options.veganLevel,
      city: city ?? '',
      cuisine,
    });

  return {
    sourceId: osmSourceId(el),
    name: name.slice(0, 120),
    type: options.type,
    veganLevel: options.veganLevel,
    location: point,
    address: address.slice(0, 240) || undefined,
    city: city?.slice(0, 80),
    postcode: tags['addr:postcode']?.trim().slice(0, 16),
    website: optionalUrl(tags.website ?? tags['contact:website']),
    phone: (tags.phone ?? tags['contact:phone'])?.trim().slice(0, 40),
    hours: tags.opening_hours?.trim().slice(0, 200),
    tags: allTags,
    description,
    chain: Boolean(tags.brand || tags['brand:wikidata']),
    sourceUrl: osmUrl(el),
  };
}

export function summarize(items: PlaceItem[]) {
  const byType: Record<string, number> = {};
  const byArea: Record<string, number> = {};
  let full = 0;
  let chains = 0;
  for (const p of items) {
    byType[p.type] = (byType[p.type] ?? 0) + 1;
    const area = areaForPoint(p.location.lng, p.location.lat);
    byArea[area] = (byArea[area] ?? 0) + 1;
    if (p.veganLevel === 'full') full += 1;
    if (p.chain) chains += 1;
  }
  return { total: items.length, full, options: items.length - full, chains, byType, byArea };
}

export interface ImporterRun {
  name: string;
  query: string;
  map: (el: OverpassElement) => PlaceItem | null;
}

/**
 * Flags: `--dry-run` fetches and prints counts without connecting;
 * `--approve` treats OSM as trusted for this run (new rows approved, pending
 * OSM rows promoted). Listing `osm` in `TRUSTED_SOURCES` does the same.
 */
export async function runImporter(run: ImporterRun): Promise<void> {
  loadDotenv({ quiet: true });
  const dryRun = process.argv.includes('--dry-run');
  const approve = process.argv.includes('--approve');
  const env = loadEnv(
    dryRun
      ? { ...process.env, MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://dry-run' }
      : process.env,
  );
  const logger = createLogger({ NODE_ENV: env.NODE_ENV, LOG_LEVEL: 'info' });

  logger.info({ url: env.OVERPASS_URL, run: run.name }, 'fetching from Overpass');
  const elements = await fetchOverpass(env.OVERPASS_URL, run.query);
  const items = elements.map(run.map).filter((p): p is PlaceItem => p !== null);
  logger.info(
    { fetched: elements.length, skipped: elements.length - items.length, ...summarize(items) },
    'mapped',
  );

  if (dryRun) {
    logger.info('dry run: nothing written');
    return;
  }

  await connectDb(env, logger);
  try {
    await backfillProvenance(logger);
    const trusted = approve || env.TRUSTED_SOURCES.includes(OSM_SOURCE);
    const totals = await ingestInBatches(items, trusted, logger);
    await PlaceModel.updateMany({ source: OSM_SOURCE, osmId: { $exists: false } }, [
      { $set: { osmId: '$sourceId' } },
    ]);
    logger.info({ ...totals, trusted }, 'seed complete');
  } finally {
    await disconnectDb();
  }
}

/** One-time: rows from the first import carry `osmId` only; copy it into `sourceId`. */
async function backfillProvenance(logger: Logger): Promise<void> {
  const provenance = await PlaceModel.updateMany(
    { osmId: { $exists: true }, sourceId: { $exists: false } },
    [{ $set: { sourceId: '$osmId', source: OSM_SOURCE } }],
  );
  const chain = await PlaceModel.updateMany(
    { chain: { $exists: false } },
    { $set: { chain: false } },
  );
  const edited = await PlaceModel.updateMany(
    { adminEdited: { $exists: false } },
    { $set: { adminEdited: [] } },
  );
  if (provenance.modifiedCount || chain.modifiedCount || edited.modifiedCount) {
    logger.info(
      {
        sourceId: provenance.modifiedCount,
        chain: chain.modifiedCount,
        adminEdited: edited.modifiedCount,
      },
      'backfilled legacy rows',
    );
  }
}

async function ingestInBatches(
  items: PlaceItem[],
  trusted: boolean,
  logger: Logger,
): Promise<Omit<IngestResult, 'rejected'> & { rejected: number }> {
  const totals = { inserted: 0, updated: 0, unchanged: 0, rejected: 0 };
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await ingestItems('places', OSM_SOURCE, batch, { trusted });
    totals.inserted += result.inserted;
    totals.updated += result.updated;
    totals.unchanged += result.unchanged;
    totals.rejected += result.rejected.length;
    for (const r of result.rejected.slice(0, 3)) {
      logger.warn({ sourceId: r.sourceId, errors: r.errors }, 'item rejected');
    }
  }
  return totals;
}
