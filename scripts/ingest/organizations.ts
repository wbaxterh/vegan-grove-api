/**
 * Ingest curated organizations (chapters, sanctuaries, orgs) from a JSON
 * file and POST them to `/api/ingest/organizations`.
 *
 *   npm run ingest:organizations -- --dry-run          # validate the file, print counts
 *   npm run ingest:organizations                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:organizations -- --input other.json
 *
 * File shape: `{ "source": "curated", "items": [ organization item ... ] }`
 * where each item follows the organizations schema in the ingest contract
 * (`sourceId`, `name`, `type`, optional `description`, `website`, `socials`,
 * `area`, `sourceUrl`). Every entry in scripts/data/organizations.json was
 * checked against the organization's own site before it went in. An item
 * whose slug matches an unverified host stub created by the event scrapers
 * adopts that stub rather than duplicating it.
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

interface CuratedFile {
  source: string;
  items: unknown[];
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const file = dataPath(argValue(ctx.args, 'input') ?? 'organizations.json');
  const data = readJson<CuratedFile>(file);
  if (!data.source || !Array.isArray(data.items)) {
    throw new Error(`${file} must be { source, items[] }`);
  }
  ctx.logger.info({ file, source: data.source, items: data.items.length }, 'organizations');
  await postIngest(ctx, 'organizations', data.source, data.items);
}

if (isMain(import.meta.url)) runScript(main);
