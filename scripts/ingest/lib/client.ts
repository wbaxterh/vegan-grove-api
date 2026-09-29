/**
 * Shared plumbing for the ingest scripts: environment, the descriptive
 * User-Agent, and the idempotent POST to `${API_URL}/api/ingest/<resource>`
 * in batches of 200 with `INGEST_KEY`. Every script supports `--dry-run`,
 * which maps and counts but never talks to the API.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { type Env, loadEnv } from '../../../src/config/env.js';
import { createLogger, type Logger } from '../../../src/lib/logger.js';
import type { IngestResource } from '../../../src/models/enums.js';
import type { IngestResult } from '../../../src/services/ingest.js';

export const INGEST_USER_AGENT = 'vegan-grove-ingest/0.1 (+https://vegangrove.org; data ingest)';
/** The product token robots.txt groups are matched against. */
export const ROBOTS_TOKEN = 'vegan-grove-ingest';
export const INGEST_BATCH = 200;

export interface ScriptContext {
  env: Env;
  logger: Logger;
  dryRun: boolean;
  args: string[];
}

/**
 * Load `.env`, validate it, and decide dry-run. The scripts never open a
 * database connection, so a missing MONGODB_URI is filled with a placeholder.
 */
export function scriptContext(): ScriptContext {
  loadDotenv({ quiet: true });
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const env = loadEnv({
    ...process.env,
    MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://ingest-scripts-never-connect',
  });
  const logger = createLogger({ NODE_ENV: env.NODE_ENV, LOG_LEVEL: 'info' });
  if (!dryRun && !env.INGEST_KEY) {
    throw new Error('INGEST_KEY is not set; run with --dry-run or set it in the environment');
  }
  return { env, logger, dryRun, args };
}

/** `--name=value` or `--name value`. */
export function argValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  const next = args[index + 1];
  return index >= 0 && next && !next.startsWith('--') ? next : undefined;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolve a path under `scripts/data/` unless it is already absolute. */
export function dataPath(relative: string): string {
  return path.isAbsolute(relative) ? relative : path.join(HERE, '..', '..', 'data', relative);
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export interface Totals {
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
}

export const emptyTotals = (): Totals => ({
  received: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  rejected: 0,
});

export function addTotals(into: Totals, from: Totals): Totals {
  into.received += from.received;
  into.inserted += from.inserted;
  into.updated += from.updated;
  into.unchanged += from.unchanged;
  into.rejected += from.rejected;
  return into;
}

/**
 * POST one source's items in batches. 200 and 207 are both success from the
 * script's point of view: rejected items are logged by sourceId and error,
 * never by content, and counted. Anything else throws.
 */
export async function postIngest(
  ctx: ScriptContext,
  resource: IngestResource,
  source: string,
  items: unknown[],
): Promise<Totals> {
  const totals = emptyTotals();
  totals.received = items.length;
  if (ctx.dryRun) {
    ctx.logger.info({ resource, source, items: items.length }, 'dry run: would POST');
    return totals;
  }
  for (let i = 0; i < items.length; i += INGEST_BATCH) {
    const batch = items.slice(i, i + INGEST_BATCH);
    const res = await fetch(`${ctx.env.API_URL}/api/ingest/${resource}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Key': ctx.env.INGEST_KEY ?? '',
        'User-Agent': INGEST_USER_AGENT,
      },
      body: JSON.stringify({ source, items: batch }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status !== 200 && res.status !== 207) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`ingest ${resource} from ${source}: HTTP ${res.status} ${text}`);
    }
    const result = (await res.json()) as IngestResult;
    totals.inserted += result.inserted;
    totals.updated += result.updated;
    totals.unchanged += result.unchanged;
    totals.rejected += result.rejected.length;
    for (const r of result.rejected.slice(0, 5)) {
      ctx.logger.warn({ resource, source, sourceId: r.sourceId, errors: r.errors }, 'rejected');
    }
  }
  ctx.logger.info({ resource, source, ...totals }, 'ingested');
  return totals;
}

export function runScript(main: () => Promise<void>): void {
  main().catch((err) => {
    process.stderr.write(`ingest failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

/** True when this module is the entry point (so tests can import scripts without running them). */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(importMetaUrl));
}
