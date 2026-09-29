/**
 * Enrich media items that carry a TMDB id with a synopsis, a poster and US
 * watch providers, then POST them back to `/api/ingest/media` under their
 * original source and sourceId (so a film never gets a second row).
 *
 *   npm run ingest:media:tmdb -- --dry-run            # fetch, map, print counts, no uploads
 *   npm run ingest:media:tmdb                         # POST with INGEST_KEY to API_URL
 *   npm run ingest:media:tmdb -- --input items.json   # a different input file
 *
 * Input: scripts/data/generated/media-wikidata.json, written by
 * `ingest:media:wikidata`, shaped `{ source, items }`; only items with
 * `externalIds.tmdb` are touched. Needs `TMDB_API_KEY`. Posters are
 * downloaded from TMDB and uploaded to `S3_MEDIA_BUCKET` under
 * `media/posters/<tmdbId>.jpg` with the AWS SDK (credentials from the usual
 * chain); the API only ever receives the key, never a remote image URL. When
 * the bucket is not configured the poster step is skipped and logged.
 *
 * Watch providers come from TMDB's JustWatch-powered endpoint for region US.
 * Their terms require attribution, so every enriched item carries the tag
 * "Watch providers data by JustWatch", and this product uses the TMDB API
 * but is not endorsed or certified by TMDB.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
  type ScriptContext,
  scriptContext,
} from './lib/client.js';

export const JUSTWATCH_ATTRIBUTION = 'Watch providers data by JustWatch';
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w500';
const PACE_MS = 250;

interface InputFile {
  source: string;
  items: MediaItemInput[];
}

interface TmdbMovie {
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
}

interface TmdbProviders {
  results?: Record<
    string,
    { link?: string; flatrate?: Provider[]; rent?: Provider[]; buy?: Provider[] }
  >;
}

interface Provider {
  provider_name?: string;
}

async function tmdbGet<T>(pathname: string, key: string): Promise<T> {
  const res = await fetch(`${TMDB_API}${pathname}?api_key=${encodeURIComponent(key)}`, {
    headers: { 'User-Agent': INGEST_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TMDB ${pathname}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function uploadPoster(
  ctx: ScriptContext,
  s3: S3Client | null,
  tmdbId: string,
  posterPath: string,
): Promise<string | undefined> {
  const key = `media/posters/${tmdbId}.jpg`;
  if (!s3 || !ctx.env.S3_MEDIA_BUCKET) {
    ctx.logger.warn({ tmdbId }, 'S3_MEDIA_BUCKET not set; poster skipped');
    return undefined;
  }
  if (ctx.dryRun) return key;
  const res = await fetch(`${TMDB_IMAGE}${posterPath}`, {
    headers: { 'User-Agent': INGEST_USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`poster ${tmdbId}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  await s3.send(
    new PutObjectCommand({
      Bucket: ctx.env.S3_MEDIA_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return key;
}

/** Providers by name, each pointing at the one JustWatch page TMDB gives per title. */
export function providersToWatchLinks(
  providers: TmdbProviders,
  region = 'US',
): NonNullable<MediaItemInput['watchLinks']> {
  const entry = providers.results?.[region];
  if (!entry?.link) return [];
  const names = new Set<string>();
  for (const group of [entry.flatrate, entry.rent, entry.buy]) {
    for (const p of group ?? []) if (p.provider_name) names.add(p.provider_name.trim());
  }
  const link = entry.link;
  return Array.from(names)
    .slice(0, 20)
    .map((provider) => ({ provider: provider.slice(0, 60), url: link }));
}

export function withAttribution(tags: string[] | undefined): string[] {
  const out = [...(tags ?? [])];
  if (!out.includes('tmdb')) out.push('tmdb');
  if (!out.includes(JUSTWATCH_ATTRIBUTION)) out.push(JUSTWATCH_ATTRIBUTION);
  return out.slice(0, 30);
}

async function enrich(
  ctx: ScriptContext,
  s3: S3Client | null,
  key: string,
  item: MediaItemInput,
): Promise<MediaItemInput> {
  const tmdbId = item.externalIds?.tmdb as string;
  const movie = await tmdbGet<TmdbMovie>(`/movie/${tmdbId}`, key);
  const providers = await tmdbGet<TmdbProviders>(`/movie/${tmdbId}/watch/providers`, key);
  const posterKey = movie.poster_path
    ? await uploadPoster(ctx, s3, tmdbId, movie.poster_path)
    : undefined;
  const year = movie.release_date ? Number(movie.release_date.slice(0, 4)) : Number.NaN;
  const links = providersToWatchLinks(providers);
  return {
    ...item,
    year: item.year ?? (Number.isFinite(year) ? year : undefined),
    synopsis: item.synopsis || movie.overview?.trim().slice(0, 4000) || undefined,
    posterKey: posterKey ?? item.posterKey,
    watchLinks: links.length > 0 ? links : item.watchLinks,
    tags: withAttribution(item.tags),
  };
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const apiKey = ctx.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY is not set');
  const file = dataPath(argValue(ctx.args, 'input') ?? 'generated/media-wikidata.json');
  const input = readJson<InputFile>(file);
  const candidates = input.items.filter((i) => i.externalIds?.tmdb);
  ctx.logger.info({ file, source: input.source, candidates: candidates.length }, 'tmdb enrichment');
  const s3 = ctx.env.S3_MEDIA_BUCKET ? new S3Client({ region: ctx.env.AWS_REGION }) : null;

  const enriched: MediaItemInput[] = [];
  for (const item of candidates) {
    try {
      enriched.push(await enrich(ctx, s3, apiKey, item));
    } catch (err) {
      ctx.logger.warn({ sourceId: item.sourceId, err }, 'enrichment failed; item skipped');
    }
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
  const totals = emptyTotals();
  addTotals(totals, await postIngest(ctx, 'media', input.source, enriched));
  ctx.logger.info({ ...totals, posters: enriched.filter((i) => i.posterKey).length }, 'done');
}

if (isMain(import.meta.url)) runScript(main);
