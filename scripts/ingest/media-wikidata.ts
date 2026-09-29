/**
 * Ingest films and documentaries about veganism and animals: a curated seed
 * list first, then Wikidata discovery as a supplement. Both POST to
 * `/api/ingest/media`, and both are cached for `ingest:media:tmdb`.
 *
 *   npm run ingest:media:wikidata -- --dry-run            # query, map, print counts
 *   npm run ingest:media:wikidata                         # POST with INGEST_KEY to API_URL
 *   npm run ingest:media:wikidata -- --seed other.json    # a different seed file
 *
 * Seed: scripts/data/media-seed.json, entries `{ title, year?, kind?,
 * wikidata?, tmdb?, imdb? }`, ingested as-is under source `curated` with
 * the Q-id (else the title slug) as `sourceId`, the same convention as
 * `ingest:media:seed`; entries with a Q-id get their missing
 * IMDb and TMDB ids looked up on Wikidata. Wikidata's main-subject (P921)
 * coverage of this topic is thin (a dozen titles), so the seed is the
 * primary path and discovery fills in what the seed does not name.
 *
 * Discovery: one SPARQL query against query.wikidata.org (descriptive
 * User-Agent, as their policy asks) for items whose main subject is veganism
 * (Q181138), animal rights (Q426), intensive animal farming (Q912362) or
 * animal welfare (Q459426), plus the adjacent subjects well-known films are
 * filed under: cruelty to animals (Q40053), speciesism (Q203986) and
 * plant-based diet (Q7201457). Items must be a film, documentary film, short
 * film, television film or television series. A discovered Q-id that the
 * seed already names is skipped so the film has one row.
 *
 * `kind` is `documentary` when the genre (P136) or class is documentary film
 * (Q93204), `short` for short films, `series` for television series, else
 * `film`. `year` is the earliest publication date. `externalIds` carries the
 * Q-id, IMDb (P345) and TMDB (P4947) ids. Both batches are written to
 * scripts/data/generated/media-wikidata.json (git-ignored) for the TMDB step.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MediaItemInput } from '../../src/services/ingest.js';
import {
  addTotals,
  argValue,
  dataPath,
  emptyTotals,
  INGEST_USER_AGENT,
  isMain,
  postIngest,
  readJson,
  runScript,
  scriptContext,
} from './lib/client.js';

export const WIKIDATA_SOURCE = 'wikidata';
export const CURATED_SOURCE = 'curated';
export const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/** Subject Q-ids and the tag each one contributes. */
export const SUBJECTS: Record<string, string> = {
  Q181138: 'veganism',
  Q426: 'animal-rights',
  Q912362: 'factory-farming',
  Q459426: 'animal-welfare',
  Q40053: 'animal-cruelty',
  Q203986: 'speciesism',
  Q7201457: 'plant-based',
};

const CLASSES: Record<string, MediaItemInput['kind']> = {
  Q11424: 'film',
  Q93204: 'documentary',
  Q24862: 'short',
  Q506240: 'film',
  Q5398426: 'series',
};

const values = (ids: string[]) => ids.map((q) => `wd:${q}`).join(' ');

export const SPARQL = `
SELECT ?item ?itemLabel ?subject ?cls ?date ?imdb ?tmdb ?doc WHERE {
  VALUES ?subject { ${values(Object.keys(SUBJECTS))} }
  VALUES ?cls { ${values(Object.keys(CLASSES))} }
  ?item wdt:P921 ?subject .
  ?item wdt:P31 ?cls .
  OPTIONAL { ?item wdt:P577 ?date . }
  OPTIONAL { ?item wdt:P345 ?imdb . }
  OPTIONAL { ?item wdt:P4947 ?tmdb . }
  OPTIONAL { ?item wdt:P136 wd:Q93204 . BIND(true AS ?doc) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

/** IMDb, TMDB, year and the documentary flag for the seed entries that name a Q-id. */
export const idLookupSparql = (qids: string[]) => `
SELECT ?item ?imdb ?tmdb ?date ?doc WHERE {
  VALUES ?item { ${values(qids)} }
  OPTIONAL { ?item wdt:P345 ?imdb . }
  OPTIONAL { ?item wdt:P4947 ?tmdb . }
  OPTIONAL { ?item wdt:P577 ?date . }
  OPTIONAL { ?item wdt:P136 wd:Q93204 . BIND(true AS ?doc) }
}`;

interface Binding {
  [key: string]: { value: string } | undefined;
}

const qid = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const IMDB_RE = /^tt\d+$/;
const TMDB_RE = /^\d+$/;

type Draft = MediaItemInput & { tags: string[]; externalIds: Record<string, string> };

function newDraft(id: string, label: string, cls: MediaItemInput['kind'] | undefined): Draft {
  return {
    sourceId: id,
    title: label.slice(0, 160),
    kind: cls ?? 'film',
    tags: ['wikidata'],
    externalIds: { wikidata: id },
    sourceUrl: `https://www.wikidata.org/wiki/${id}`,
  };
}

/** Fold one binding row into the draft for its Q-id. */
function applyRow(draft: Draft, row: Binding, cls: MediaItemInput['kind'] | undefined): void {
  const isDoc = row.doc?.value === 'true' || cls === 'documentary';
  if (isDoc) draft.kind = 'documentary';
  else if (draft.kind === 'film' && cls && cls !== 'film') draft.kind = cls;

  const year = row.date ? Number(row.date.value.slice(0, 4)) : Number.NaN;
  if (Number.isFinite(year) && year >= 1900 && (!draft.year || year < draft.year)) {
    draft.year = year;
  }
  const subjectTag = row.subject ? SUBJECTS[qid(row.subject.value)] : undefined;
  if (subjectTag && !draft.tags.includes(subjectTag)) draft.tags.push(subjectTag);
  if (row.imdb?.value && IMDB_RE.test(row.imdb.value)) draft.externalIds.imdb = row.imdb.value;
  if (row.tmdb?.value && TMDB_RE.test(row.tmdb.value)) draft.externalIds.tmdb = row.tmdb.value;
}

/** Collapse the one-row-per-value bindings into one item per Q-id. Exported for the tests. */
export function bindingsToMediaItems(bindings: Binding[]): MediaItemInput[] {
  const byId = new Map<string, Draft>();
  for (const row of bindings) {
    const item = row.item?.value;
    const label = row.itemLabel?.value?.trim();
    if (!item || !label) continue;
    const id = qid(item);
    if (label === id) continue;
    const cls = row.cls ? CLASSES[qid(row.cls.value)] : undefined;
    const draft = byId.get(id) ?? newDraft(id, label, cls);
    applyRow(draft, row, cls);
    byId.set(id, draft);
  }
  return Array.from(byId.values()).sort((a, b) => a.title.localeCompare(b.title));
}

export interface SeedEntry {
  title: string;
  year?: number;
  kind?: MediaItemInput['kind'];
  wikidata?: string;
  tmdb?: string | number;
  imdb?: string;
  tags?: string[];
}

const slugish = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function seedExternalIds(e: SeedEntry): Record<string, string> | undefined {
  const ids: Record<string, string> = {};
  if (e.wikidata && /^Q\d+$/.test(e.wikidata)) ids.wikidata = e.wikidata;
  if (e.tmdb !== undefined && TMDB_RE.test(String(e.tmdb))) ids.tmdb = String(e.tmdb);
  if (e.imdb && IMDB_RE.test(e.imdb)) ids.imdb = e.imdb;
  return Object.keys(ids).length > 0 ? ids : undefined;
}

/** Seed entries as curated media items, ids as given. Exported for the tests. */
export function seedToMediaItems(entries: SeedEntry[]): MediaItemInput[] {
  return entries
    .filter((e) => typeof e.title === 'string' && e.title.trim())
    .map((e) => {
      const externalIds = seedExternalIds(e);
      const title = e.title.trim().slice(0, 160);
      return {
        sourceId: externalIds?.wikidata ?? slugish(title),
        title,
        kind: e.kind ?? 'documentary',
        year: e.year,
        tags: Array.from(new Set(['curated', ...(e.tags ?? [])])),
        externalIds,
        sourceUrl: externalIds?.wikidata
          ? `https://www.wikidata.org/wiki/${externalIds.wikidata}`
          : undefined,
      };
    });
}

async function sparql(query: string): Promise<Binding[]> {
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': INGEST_USER_AGENT, Accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL: HTTP ${res.status}`);
  const body = (await res.json()) as { results?: { bindings?: Binding[] } };
  return body.results?.bindings ?? [];
}

/** Copy what the lookup found onto a seed item without overwriting what the seed said. */
function applyLookupRow(item: MediaItemInput, row: Binding): void {
  const ids = item.externalIds as Record<string, string>;
  if (!ids.imdb && row.imdb?.value && IMDB_RE.test(row.imdb.value)) ids.imdb = row.imdb.value;
  if (!ids.tmdb && row.tmdb?.value && TMDB_RE.test(row.tmdb.value)) ids.tmdb = row.tmdb.value;
  const year = row.date ? Number(row.date.value.slice(0, 4)) : Number.NaN;
  if (!item.year && Number.isFinite(year) && year >= 1900) item.year = year;
  if (row.doc?.value === 'true') item.kind = 'documentary';
}

/** Fill missing IMDb/TMDB ids, year and documentary flag on seed items that name a Q-id. */
async function enrichSeedFromWikidata(items: MediaItemInput[]): Promise<void> {
  const byId = new Map<string, MediaItemInput>();
  for (const item of items) {
    if (item.externalIds?.wikidata) byId.set(item.externalIds.wikidata, item);
  }
  if (byId.size === 0) return;
  for (const row of await sparql(idLookupSparql(Array.from(byId.keys())))) {
    const item = row.item ? byId.get(qid(row.item.value)) : undefined;
    if (item) applyLookupRow(item, row);
  }
}

export interface MediaCache {
  batches: Array<{ source: string; items: MediaItemInput[] }>;
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const seedFile = dataPath(argValue(ctx.args, 'seed') ?? 'media-seed.json');
  const seed = existsSync(seedFile) ? seedToMediaItems(readJson<SeedEntry[]>(seedFile)) : [];
  await enrichSeedFromWikidata(seed);
  const seeded = new Set(seed.map((i) => i.externalIds?.wikidata).filter(Boolean));

  const bindings = await sparql(SPARQL);
  const discovered = bindingsToMediaItems(bindings).filter(
    (i) => !seeded.has(i.externalIds?.wikidata),
  );
  const all = [...seed, ...discovered];
  ctx.logger.info(
    {
      seed: seed.length,
      rows: bindings.length,
      discovered: discovered.length,
      documentaries: all.filter((i) => i.kind === 'documentary').length,
      withTmdb: all.filter((i) => i.externalIds?.tmdb).length,
    },
    'mapped',
  );

  const cache: MediaCache = {
    batches: [
      { source: CURATED_SOURCE, items: seed },
      { source: WIKIDATA_SOURCE, items: discovered },
    ],
  };
  const cachePath = dataPath(path.join('generated', 'media-wikidata.json'));
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  ctx.logger.info({ cache: cachePath }, 'wrote cache for ingest:media:tmdb');

  const totals = emptyTotals();
  for (const batch of cache.batches) {
    if (batch.items.length === 0) continue;
    addTotals(totals, await postIngest(ctx, 'media', batch.source, batch.items));
  }
  ctx.logger.info(totals, 'done');
}

if (isMain(import.meta.url)) runScript(main);
