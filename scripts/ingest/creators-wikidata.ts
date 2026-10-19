/**
 * Enrich creators with social handles from Wikidata. Reads QIDs from the seed
 * and fills in handles the seed left empty. Re-sends each row under its
 * existing key so the upsert updates instead of creating a duplicate.
 *
 *   npm run ingest:creators:wikidata -- --dry-run   # query, map, print counts
 *   npm run ingest:creators:wikidata                # POST with INGEST_KEY to API_URL
 *
 * Wikidata is CC0. The query retrieves:
 * - P856  official website
 * - P2397 YouTube channel ID
 * - P2003 Instagram username
 * - P7085 TikTok username
 * - P2002 X (Twitter) username
 * - P12361 Bluesky handle
 * - P4033 Mastodon address
 */

import { type SeedEntry, toItem } from './creators-seed.js';
import {
  argValue,
  dataPath,
  INGEST_USER_AGENT,
  isMain,
  postIngest,
  readJson,
  runScript,
  scriptContext,
} from './lib/client.js';

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

const idLookupSparql = (qids: string[]) => `
SELECT ?item ?website ?youtube ?instagram ?tiktok ?x ?bluesky ?mastodon WHERE {
  VALUES ?item { ${qids.map((q) => `wd:${q}`).join(' ')} }
  OPTIONAL { ?item wdt:P856 ?website . }
  OPTIONAL { ?item wdt:P2397 ?youtube . }
  OPTIONAL { ?item wdt:P2003 ?instagram . }
  OPTIONAL { ?item wdt:P7085 ?tiktok . }
  OPTIONAL { ?item wdt:P2002 ?x . }
  OPTIONAL { ?item wdt:P12361 ?bluesky . }
  OPTIONAL { ?item wdt:P4033 ?mastodon . }
}`;

interface Binding {
  [key: string]: { value: string } | undefined;
}

const qid = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

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

function applyLookupRow(entry: SeedEntry, row: Binding): void {
  if (!entry.website && row.website?.value) {
    entry.website = row.website.value;
  }
  entry.socials = entry.socials ?? {};
  if (!entry.socials.youtube && row.youtube?.value) {
    entry.socials.youtube = row.youtube.value;
  }
  if (!entry.socials.instagram && row.instagram?.value) {
    entry.socials.instagram = row.instagram.value;
  }
  if (!entry.socials.tiktok && row.tiktok?.value) {
    entry.socials.tiktok = row.tiktok.value;
  }
  if (!entry.socials.x && row.x?.value) {
    entry.socials.x = row.x.value;
  }
  if (!entry.socials.bluesky && row.bluesky?.value) {
    entry.socials.bluesky = row.bluesky.value;
  }
  if (!entry.socials.mastodon && row.mastodon?.value) {
    entry.socials.mastodon = row.mastodon.value;
  }
}

async function enrichSeedFromWikidata(entries: SeedEntry[]): Promise<void> {
  const byId = new Map<string, SeedEntry>();
  for (const entry of entries) {
    if (entry.wikidata) byId.set(entry.wikidata, entry);
  }
  if (byId.size === 0) return;
  for (const row of await sparql(idLookupSparql(Array.from(byId.keys())))) {
    const entry = row.item ? byId.get(qid(row.item.value)) : undefined;
    if (entry) applyLookupRow(entry, row);
  }
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const file = dataPath(argValue(ctx.args, 'input') ?? 'creators-seed.json');
  const entries = readJson<SeedEntry[]>(file);
  if (!Array.isArray(entries)) throw new Error(`${file} must be an array of seed entries`);

  const withQid = entries.filter((e) => e.wikidata);
  ctx.logger.info({ total: entries.length, withQid: withQid.length }, 'enriching from Wikidata');

  await enrichSeedFromWikidata(entries);

  const items = entries.map(toItem);
  ctx.logger.info(
    {
      file,
      items: items.length,
      enriched: withQid.length,
    },
    'creators enriched',
  );
  await postIngest(ctx, 'creators', 'curated', items);
}

if (isMain(import.meta.url)) runScript(main);
