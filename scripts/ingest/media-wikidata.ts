/**
 * Ingest films and documentaries about veganism and animals from Wikidata
 * and POST them to `/api/ingest/media` as `source: wikidata`.
 *
 *   npm run ingest:media:wikidata -- --dry-run   # query, map, print counts
 *   npm run ingest:media:wikidata                # POST with INGEST_KEY to API_URL
 *
 * One SPARQL query against query.wikidata.org (descriptive User-Agent, as
 * their policy asks): items whose main subject (P921) is veganism (Q181138),
 * animal rights (Q426), intensive animal farming (Q912362) or animal welfare
 * (Q459426), plus the closely related subjects the well-known films are
 * actually filed under on Wikidata: cruelty to animals (Q40053), speciesism
 * (Q203986) and plant-based diet (Q7201457). Without that second tier the
 * query misses Earthlings, Dominion and Cowspiracy. Items must be a film,
 * documentary film, short film, television film or television series.
 *
 * `kind` is `documentary` when the genre (P136) or class is documentary film
 * (Q93204), `short` for short films, `series` for television series, else
 * `film`. `year` is the earliest publication date. `externalIds` carries the
 * Q-id, IMDb (P345) and TMDB (P4947) ids so `ingest:media:tmdb` can enrich
 * the same rows. The mapped items are also written to
 * scripts/data/generated/media-wikidata.json (git-ignored) for that script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MediaItemInput } from '../../src/services/ingest.js';
import {
  dataPath,
  INGEST_USER_AGENT,
  isMain,
  postIngest,
  runScript,
  scriptContext,
} from './lib/client.js';

export const WIKIDATA_SOURCE = 'wikidata';
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

export const SPARQL = `
SELECT ?item ?itemLabel ?subject ?cls ?date ?imdb ?tmdb ?doc WHERE {
  VALUES ?subject { ${Object.keys(SUBJECTS)
    .map((q) => `wd:${q}`)
    .join(' ')} }
  VALUES ?cls { ${Object.keys(CLASSES)
    .map((q) => `wd:${q}`)
    .join(' ')} }
  ?item wdt:P921 ?subject .
  ?item wdt:P31 ?cls .
  OPTIONAL { ?item wdt:P577 ?date . }
  OPTIONAL { ?item wdt:P345 ?imdb . }
  OPTIONAL { ?item wdt:P4947 ?tmdb . }
  OPTIONAL { ?item wdt:P136 wd:Q93204 . BIND(true AS ?doc) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

interface Binding {
  [key: string]: { value: string } | undefined;
}

const qid = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

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
  if (row.imdb?.value && /^tt\d+$/.test(row.imdb.value)) draft.externalIds.imdb = row.imdb.value;
  if (row.tmdb?.value && /^\d+$/.test(row.tmdb.value)) draft.externalIds.tmdb = row.tmdb.value;
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

export async function queryWikidata(): Promise<Binding[]> {
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(SPARQL)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': INGEST_USER_AGENT, Accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL: HTTP ${res.status}`);
  const body = (await res.json()) as { results?: { bindings?: Binding[] } };
  return body.results?.bindings ?? [];
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const bindings = await queryWikidata();
  const items = bindingsToMediaItems(bindings);
  ctx.logger.info(
    {
      rows: bindings.length,
      items: items.length,
      documentaries: items.filter((i) => i.kind === 'documentary').length,
      withTmdb: items.filter((i) => i.externalIds?.tmdb).length,
    },
    'mapped',
  );

  const cache = dataPath(path.join('generated', 'media-wikidata.json'));
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, `${JSON.stringify({ source: WIKIDATA_SOURCE, items }, null, 2)}\n`);
  ctx.logger.info({ cache }, 'wrote cache for ingest:media:tmdb');

  await postIngest(ctx, 'media', WIKIDATA_SOURCE, items);
}

if (isMain(import.meta.url)) runScript(main);
