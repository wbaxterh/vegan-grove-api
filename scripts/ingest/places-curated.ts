/**
 * Ingest curated places (sanctuaries, gardens) from hand-checked JSON files
 * and POST them to `/api/ingest/places`.
 *
 *   npm run ingest:places:curated                    # all curated files
 *   npm run ingest:places:curated -- --dry-run       # print what would be posted
 *   npm run ingest:sanctuaries                       # sanctuaries only
 *   npm run ingest:gardens:curated                   # curated gardens only
 *
 * Trust is determined server-side by TRUSTED_SOURCES. If `curated` is listed
 * there, rows land approved; otherwise they land pending. The scripts do not
 * pass an --approve flag.
 *
 * Rich fields preserved: website, phone, hours, address, city, description,
 * tags, sourceUrl (website), and coordinates. Photos are not ingested because
 * the ingest schema does not accept photo keys and the runbook forbids
 * hotlinking or bucket credentials on the bot.
 */
import type { HomeArea, PlaceType, VeganLevel } from '../../src/models/index.js';
import type { PlaceItem } from '../../src/services/ingest.js';
import {
  addTotals,
  argValue,
  dataPath,
  emptyTotals,
  isMain,
  postIngest,
  readJson,
  runScript,
  scriptContext,
  type Totals,
} from './lib/client.js';

const CURATED_SOURCE = 'curated';

interface CuratedEntry {
  name: string;
  type?: PlaceType;
  address: string;
  city: string;
  area: HomeArea;
  lat: number;
  lng: number;
  website: string;
  phone?: string;
  hours?: string;
  description: string;
  tags: string[];
}

function toCuratedPlaceItem(
  entry: CuratedEntry,
  defaultType: PlaceType,
  veganLevel: VeganLevel,
): PlaceItem {
  return {
    sourceId: slugify(entry.name),
    name: entry.name.slice(0, 120),
    type: entry.type ?? defaultType,
    veganLevel,
    location: { lng: entry.lng, lat: entry.lat },
    address: entry.address.slice(0, 240) || undefined,
    city: entry.city.slice(0, 80),
    website: entry.website.slice(0, 500) || undefined,
    phone: entry.phone?.slice(0, 40),
    hours: entry.hours?.slice(0, 200),
    description: entry.description.slice(0, 2000),
    tags: [CURATED_SOURCE, ...(entry.tags ?? [])].slice(0, 30),
    sourceUrl: entry.website.slice(0, 500) || undefined,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

interface CuratedFile {
  file: string;
  type: PlaceType;
  veganLevel: VeganLevel;
}

const CURATED_FILES: CuratedFile[] = [
  { file: 'sanctuaries.json', type: 'sanctuary', veganLevel: 'full' },
  { file: 'gardens-curated.json', type: 'garden', veganLevel: 'full' },
];

export async function ingestCuratedPlaces(files: CuratedFile[] = CURATED_FILES): Promise<Totals> {
  const ctx = scriptContext();
  const totals = emptyTotals();

  for (const { file, type, veganLevel } of files) {
    const path = dataPath(file);
    let entries: CuratedEntry[];
    try {
      entries = readJson<CuratedEntry[]>(path);
    } catch (err) {
      ctx.logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'skipped');
      continue;
    }
    const items = entries.map((e) => toCuratedPlaceItem(e, type, veganLevel));
    ctx.logger.info({ file, type, count: items.length }, 'curated places');

    const result = await postIngest(ctx, 'places', CURATED_SOURCE, items);
    addTotals(totals, result);
  }

  ctx.logger.info({ ...totals }, 'curated ingest complete');
  return totals;
}

if (isMain(import.meta.url)) {
  runScript(async () => {
    const ctx = scriptContext();
    const inputArg = argValue(ctx.args, 'input');
    const typeArg = argValue(ctx.args, 'type') as PlaceType | undefined;

    if (inputArg) {
      const type = typeArg ?? 'sanctuary';
      const veganLevel = type === 'sanctuary' || type === 'garden' ? 'full' : 'full';
      await ingestCuratedPlaces([{ file: inputArg, type, veganLevel }]);
    } else if (typeArg) {
      const filtered = CURATED_FILES.filter((f) => f.type === typeArg);
      await ingestCuratedPlaces(filtered);
    } else {
      await ingestCuratedPlaces();
    }
  });
}
