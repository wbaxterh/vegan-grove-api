/**
 * Shared OpenStreetMap plumbing for the place importers: the tiled Overpass
 * fetch, the tag-to-field mapping, and the run loop that hands mapped items
 * to the ingest service in batches. Both `seed-places-osm.ts` and
 * `seed-places-gardens.ts` are thin wrappers over this file.
 *
 * Overpass mirrors time out on the whole Southern California box, so the
 * query runs per 0.25 degree tile with retries and a backoff, falling back
 * from `OVERPASS_URL` to overpass-api.de (honouring its Retry-After on 429).
 * Elements that straddle a tile edge come back twice and are de-duplicated
 * by OSM id.
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
export const OVERPASS_FALLBACK_URL = 'https://overpass-api.de/api/interpreter';
const BATCH_SIZE = 200;
const TILE_DEGREES = 0.25;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 6_000, 15_000];
const RATE_LIMIT_WAIT_MS = 30_000;
const TILE_PACE_MS = 500;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** An Overpass QL query for one `s,w,n,e` box. */
export type QueryBuilder = (bbox: string) => string;

/** Split an `s,w,n,e` box into tiles of at most `size` degrees a side. */
export function tileBbox(bbox: string, size: number = TILE_DEGREES): string[] {
  const [s, w, n, e] = bbox.split(',').map(Number) as [number, number, number, number];
  const tiles: string[] = [];
  const round = (v: number) => Number(v.toFixed(4));
  for (let lat = s; lat < n; lat = round(lat + size)) {
    for (let lng = w; lng < e; lng = round(lng + size)) {
      const top = Math.min(round(lat + size), n);
      const right = Math.min(round(lng + size), e);
      tiles.push(`${lat},${lng},${top},${right}`);
    }
  }
  return tiles;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class OverpassError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`Overpass HTTP ${status}`);
  }
}

async function overpassOnce(url: string, query: string): Promise<OverpassElement[]> {
  const res = await fetch(`${url}?data=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': OSM_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new OverpassError(res.status, Number.isFinite(retryAfter) ? retryAfter * 1000 : null);
  }
  const body = (await res.json()) as { elements?: OverpassElement[] };
  return body.elements ?? [];
}

/** Retry one mirror with backoff; 429 waits for Retry-After (or 30 s) instead. */
async function withRetries(url: string, query: string, logger: Logger): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await overpassOnce(url, query);
    } catch (err) {
      lastError = err;
      const status = err instanceof OverpassError ? err.status : 0;
      const wait =
        status === 429
          ? ((err as OverpassError).retryAfterMs ?? RATE_LIMIT_WAIT_MS)
          : (BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
      logger.warn(
        { url, status: status || 'network', attempt: attempt + 1, wait },
        'overpass retry',
      );
      await sleep(wait ?? RATE_LIMIT_WAIT_MS);
    }
  }
  throw lastError;
}

async function fetchTile(
  primaryUrl: string,
  query: string,
  logger: Logger,
): Promise<OverpassElement[]> {
  try {
    return await withRetries(primaryUrl, query, logger);
  } catch (err) {
    if (primaryUrl === OVERPASS_FALLBACK_URL) throw err;
    logger.warn({ err }, 'primary mirror failed for tile, trying overpass-api.de');
    return withRetries(OVERPASS_FALLBACK_URL, query, logger);
  }
}

export interface TiledResult {
  elements: OverpassElement[];
  /** Tiles both mirrors gave up on; their rows simply keep last run's values. */
  failedTiles: string[];
}

/**
 * Run `build(tile)` for every tile of the SoCal box and merge the results by OSM id.
 * A tile that fails on both mirrors is skipped, not fatal: the importer only ever upserts,
 * so landing 139 tiles beats discarding an hour of them because the 140th timed out.
 */
export async function fetchOverpassTiled(
  primaryUrl: string,
  build: QueryBuilder,
  logger: Logger,
  bbox: string = SOCAL_BBOX,
): Promise<TiledResult> {
  const tiles = tileBbox(bbox);
  const seen = new Map<string, OverpassElement>();
  const failedTiles: string[] = [];
  for (const [i, tile] of tiles.entries()) {
    try {
      const elements = await fetchTile(primaryUrl, build(tile), logger);
      for (const el of elements) seen.set(osmSourceId(el), el);
    } catch (err) {
      failedTiles.push(tile);
      logger.warn({ tile, err: err instanceof Error ? err.message : String(err) }, 'tile skipped');
    }
    if ((i + 1) % 20 === 0 || i + 1 === tiles.length) {
      logger.info(
        { tiles: `${i + 1}/${tiles.length}`, elements: seen.size, failed: failedTiles.length },
        'overpass progress',
      );
    }
    if (i + 1 < tiles.length) await sleep(TILE_PACE_MS);
  }
  if (failedTiles.length === tiles.length) {
    throw new Error(`Overpass answered no tile at all (${tiles.length} tried)`);
  }
  return { elements: Array.from(seen.values()), failedTiles };
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
  /** Builds the Overpass QL for one tile; the run covers the SoCal box tile by tile. */
  query: QueryBuilder;
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

  logger.info({ url: env.OVERPASS_URL, run: run.name }, 'fetching from Overpass, tiled');
  const { elements, failedTiles } = await fetchOverpassTiled(env.OVERPASS_URL, run.query, logger);
  const items = elements.map(run.map).filter((p): p is PlaceItem => p !== null);
  logger.info(
    {
      fetched: elements.length,
      skipped: elements.length - items.length,
      failedTiles: failedTiles.length,
      ...summarize(items),
    },
    'mapped',
  );
  if (failedTiles.length > 0) {
    logger.warn({ failedTiles }, 'some tiles were skipped; rerun to fill them in');
  }

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
