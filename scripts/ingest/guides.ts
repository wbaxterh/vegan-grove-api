/**
 * Ingest guide drafts from a JSON file and POST them to `/api/ingest/guides`.
 *
 *   npm run ingest:guides -- --dry-run          # validate the file, print counts
 *   npm run ingest:guides                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:guides -- --input other.json
 *
 * Guides are drafted, never scraped. The file is `{ "source", "items" }`
 * where each item follows the guides schema in the ingest contract:
 * `sourceId`, `title`, `category`, markdown `body`, optional `summary`, and a
 * non-empty `sources` list of `{ title, url, license? }` citations. Drafts
 * written by a person use source `curated`; drafts a bot wrote from cited
 * sources use `bot:grokbot`. Either way they land as `draft` unless the
 * source is listed in TRUSTED_SOURCES, and an editor publishes them.
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

interface DraftsFile {
  source: string;
  items: unknown[];
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const file = dataPath(argValue(ctx.args, 'input') ?? 'guides.json');
  const data = readJson<DraftsFile>(file);
  if (!data.source || !Array.isArray(data.items)) {
    throw new Error(`${file} must be { source, items[] }`);
  }
  ctx.logger.info({ file, source: data.source, items: data.items.length }, 'guide drafts');
  await postIngest(ctx, 'guides', data.source, data.items);
}

if (isMain(import.meta.url)) runScript(main);
