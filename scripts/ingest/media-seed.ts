/**
 * Ingest the hand-curated documentary list in scripts/data/media-seed.json
 * and POST it to `/api/ingest/media` as source `curated`.
 *
 *   npm run ingest:media:seed -- --dry-run   # validate the file, print counts
 *   npm run ingest:media:seed                # POST with INGEST_KEY to API_URL
 *
 * Wikidata's subject tagging is too sparse to discover vegan and animal-rights
 * films reliably (the SPARQL path surfaces a handful), so this list is the
 * primary catalogue: each title was resolved by hand through the Wikidata API
 * to a QID and, where present, IMDb and TMDB ids. `ingest:media:tmdb` enriches
 * these rows with synopses, posters, and watch providers under the same
 * (source, sourceId) so nothing is duplicated.
 */
import {
  argValue,
  dataPath,
  isMain,
  postIngest,
  readJson,
  runScript,
  scriptContext,
} from './lib/client.js';

/** One entry of scripts/data/media-seed.json: catalogue ids plus the editorial layer. */
export interface SeedEntry {
  title: string;
  year?: number;
  wikidata?: string;
  imdb?: string;
  /** The seed file stores TMDB ids as numbers; the API wants the digit string. */
  tmdb?: number | string;
  kind?: 'documentary' | 'film' | 'series' | 'talk' | 'short';
  /** Topic tags (`ethics`, `health`, `environment`, `activism`, `investigation`) plus free tags. */
  tags?: string[];
  contentWarnings?: string[];
  officialSite?: string;
  watchLinks?: Array<{ provider: string; url: string; access?: string }>;
  actions?: Array<{ label: string; url: string; type: string; org?: string }>;
  /** Read by seed:media:collections, never sent to the ingest endpoint. */
  featured?: boolean;
}

const FEATURE_FILMS = new Set(['Okja']);
const TMDB_RE = /^\d{1,20}$/;
const IMDB_RE = /^tt\d{1,18}$/;
const WIKIDATA_RE = /^Q\d{1,19}$/;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** The seed entry as an ingest item. `sourceId` is the Wikidata id, else the slugified title. */
export function toItem(entry: SeedEntry): Record<string, unknown> {
  const title = entry.title.trim().slice(0, 160);
  const kind = entry.kind ?? (FEATURE_FILMS.has(title) ? 'film' : 'documentary');
  const externalIds: Record<string, string> = {};
  if (entry.wikidata && WIKIDATA_RE.test(entry.wikidata)) externalIds.wikidata = entry.wikidata;
  if (entry.imdb && IMDB_RE.test(entry.imdb)) externalIds.imdb = entry.imdb;
  if (entry.tmdb !== undefined && TMDB_RE.test(String(entry.tmdb))) {
    externalIds.tmdb = String(entry.tmdb);
  }
  const wikidata = externalIds.wikidata;
  return compact({
    sourceId: wikidata ?? slugify(title),
    title,
    kind,
    year: entry.year,
    tags: Array.from(new Set(['curated', ...(entry.tags ?? [])])),
    contentWarnings: entry.contentWarnings,
    officialSite: entry.officialSite,
    watchLinks: entry.watchLinks?.map((w) => ({ ...w, access: w.access ?? 'unknown' })),
    actions: entry.actions,
    externalIds: Object.keys(externalIds).length > 0 ? externalIds : undefined,
    sourceUrl: wikidata ? `https://www.wikidata.org/wiki/${wikidata}` : undefined,
  });
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const file = dataPath(argValue(ctx.args, 'input') ?? 'media-seed.json');
  const entries = readJson<SeedEntry[]>(file);
  if (!Array.isArray(entries)) throw new Error(`${file} must be an array of seed entries`);
  const items = entries.map(toItem);
  ctx.logger.info({ file, items: items.length, titles: entries.map((e) => e.title) }, 'media seed');
  await postIngest(ctx, 'media', 'curated', items);
}

if (isMain(import.meta.url)) runScript(main);
