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

interface SeedEntry {
  title: string;
  year?: number;
  wikidata?: string;
  imdb?: string;
  tmdb?: number;
  kind?: 'documentary' | 'film' | 'series' | 'talk' | 'short';
  tags?: string[];
}

const FEATURE_FILMS = new Set(['Okja']);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toItem(entry: SeedEntry): Record<string, unknown> {
  const kind = entry.kind ?? (FEATURE_FILMS.has(entry.title) ? 'film' : 'documentary');
  const externalIds: Record<string, string | number> = {};
  if (entry.wikidata) externalIds.wikidata = entry.wikidata;
  if (entry.imdb) externalIds.imdb = entry.imdb;
  if (entry.tmdb) externalIds.tmdb = entry.tmdb;
  return {
    sourceId: entry.wikidata ?? slugify(entry.title),
    title: entry.title,
    kind,
    year: entry.year,
    tags: entry.tags ?? ['curated'],
    externalIds,
    sourceUrl: entry.wikidata ? `https://www.wikidata.org/wiki/${entry.wikidata}` : undefined,
  };
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
