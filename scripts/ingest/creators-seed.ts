/**
 * Ingest the hand-curated creator list in scripts/data/creators-seed.json
 * and POST it to `/api/ingest/creators` as source `curated`.
 *
 *   npm run ingest:creators:seed -- --dry-run   # validate the file, print counts
 *   npm run ingest:creators:seed                # POST with INGEST_KEY to API_URL
 *
 * Each creator was researched by hand: vegan status verified from a public
 * source (Wikidata, Wikipedia, or the creator's own site), and links checked.
 * The ingest endpoint writes them as `draft`; an admin must review and publish.
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

export interface SeedEntry {
  sourceId: string;
  name: string;
  alsoKnownAs?: string[];
  kind?: 'person' | 'duo' | 'team';
  members?: string[];
  wikidata?: string;
  bio?: string;
  topics?: string[];
  country?: string;
  languages?: string[];
  website?: string;
  podcast?: string;
  socials?: Record<string, string>;
  veganSource?: { url: string; label: string };
  sourceUrl?: string;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function toItem(entry: SeedEntry): Record<string, unknown> {
  const wikidata = entry.wikidata;
  return compact({
    sourceId: entry.sourceId,
    name: entry.name.trim().slice(0, 120),
    alsoKnownAs: entry.alsoKnownAs,
    kind: entry.kind ?? 'person',
    members: entry.members,
    bio: entry.bio?.trim().slice(0, 280),
    topics: entry.topics,
    country: entry.country,
    languages: entry.languages,
    website: entry.website,
    podcast: entry.podcast,
    socials: entry.socials,
    wikidata,
    veganSource: entry.veganSource,
    sourceUrl:
      entry.sourceUrl ?? (wikidata ? `https://www.wikidata.org/wiki/${wikidata}` : undefined),
  });
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const file = dataPath(argValue(ctx.args, 'input') ?? 'creators-seed.json');
  const entries = readJson<SeedEntry[]>(file);
  if (!Array.isArray(entries)) throw new Error(`${file} must be an array of seed entries`);
  const items = entries.map(toItem);
  ctx.logger.info(
    {
      file,
      items: items.length,
      names: entries.map((e) => e.name),
      topics: [...new Set(entries.flatMap((e) => e.topics ?? []))].sort(),
    },
    'creators seed',
  );
  await postIngest(ctx, 'creators', 'curated', items);
}

if (isMain(import.meta.url)) runScript(main);
