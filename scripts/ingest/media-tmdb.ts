/**
 * Enrich media items that carry a TMDB id with a synopsis, tagline, poster,
 * backdrop, runtime, genres, directors, featured people, rating, US content
 * rating, the official YouTube trailer id and US watch providers, then POST
 * them back to `/api/ingest/media` under their original source and sourceId
 * (so a film never gets a second row).
 *
 *   npm run ingest:media:tmdb -- --dry-run                 # fetch, map, print counts, no uploads
 *   npm run ingest:media:tmdb                              # POST with INGEST_KEY to API_URL
 *   npm run ingest:media:tmdb -- --input media-seed.json   # enrich the curated seed directly
 *
 * Input, by default scripts/data/generated/media-wikidata.json as written by
 * `ingest:media:wikidata`: `{ batches: [{ source, items }] }` (the curated
 * seed and the Wikidata discoveries). A `{ source, items }` file or a bare
 * seed array (`scripts/data/media-seed.json`, source `curated`) is accepted
 * too. Only items with `externalIds.tmdb` are touched. Needs `TMDB_API_KEY`.
 *
 * Posters and backdrops are downloaded from TMDB and uploaded to
 * `S3_MEDIA_BUCKET` under `media/posters/<tmdbId>.jpg` and
 * `media/backdrops/<tmdbId>.jpg` with the AWS SDK (credentials from the usual
 * chain); the API only ever receives the key, never a remote image URL. When
 * the bucket is not configured the image steps are skipped and logged.
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
import {
  CURATED_SOURCE,
  type MediaCache,
  type SeedEntry,
  seedToMediaItems,
} from './media-wikidata.js';

export const JUSTWATCH_ATTRIBUTION = 'Watch providers data by JustWatch';
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'w1280';
/** One request per film: the sub-resources ride along on the movie call. */
const APPEND = 'videos,credits,release_dates';
const PACE_MS = 250;
const MAX_FEATURING = 6;

interface Batch {
  source: string;
  items: MediaItemInput[];
}

export interface TmdbMovie {
  overview?: string;
  tagline?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  runtime?: number | null;
  genres?: Array<{ name?: string }>;
  vote_average?: number;
  vote_count?: number;
  original_language?: string;
  videos?: { results?: Array<{ site?: string; type?: string; key?: string; official?: boolean }> };
  credits?: {
    crew?: Array<{ job?: string; name?: string }>;
    cast?: Array<{ name?: string; order?: number }>;
  };
  release_dates?: {
    results?: Array<{ iso_3166_1?: string; release_dates?: Array<{ certification?: string }> }>;
  };
}

interface Provider {
  provider_name?: string;
}

interface TmdbProviders {
  results?: Record<
    string,
    { link?: string; flatrate?: Provider[]; rent?: Provider[]; buy?: Provider[] }
  >;
}

/** Accept the cache, a single-source file, or the bare seed array. Exported for the tests. */
export function readBatches(data: unknown): Batch[] {
  if (Array.isArray(data)) {
    return [{ source: CURATED_SOURCE, items: seedToMediaItems(data as SeedEntry[]) }];
  }
  if (data && typeof data === 'object') {
    const obj = data as Partial<MediaCache> & Partial<Batch>;
    if (Array.isArray(obj.batches)) return obj.batches;
    if (typeof obj.source === 'string' && Array.isArray(obj.items)) {
      return [{ source: obj.source, items: obj.items }];
    }
  }
  throw new Error('input must be { batches }, { source, items } or a seed array');
}

async function tmdbGet<T>(pathname: string, key: string, append?: string): Promise<T> {
  const extra = append ? `&append_to_response=${encodeURIComponent(append)}` : '';
  const res = await fetch(`${TMDB_API}${pathname}?api_key=${encodeURIComponent(key)}${extra}`, {
    headers: { 'User-Agent': INGEST_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TMDB ${pathname}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function uploadImage(
  ctx: ScriptContext,
  s3: S3Client | null,
  key: string,
  tmdbPath: string,
  size: string,
): Promise<string | undefined> {
  if (!s3 || !ctx.env.S3_MEDIA_BUCKET) {
    ctx.logger.warn({ key }, 'S3_MEDIA_BUCKET not set; image skipped');
    return undefined;
  }
  if (ctx.dryRun) return key;
  const res = await fetch(`${TMDB_IMAGE}/${size}${tmdbPath}`, {
    headers: { 'User-Agent': INGEST_USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`image ${key}: HTTP ${res.status}`);
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

/** The one YouTube trailer id to embed: official trailers first, then any trailer, then a teaser. */
export function pickTrailer(movie: TmdbMovie): string | undefined {
  const videos = (movie.videos?.results ?? []).filter(
    (v) => v.site === 'YouTube' && v.key && /^[A-Za-z0-9_-]{6,20}$/.test(v.key),
  );
  const rank = (v: (typeof videos)[number]) =>
    (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official ? 0 : 1);
  return videos.sort((a, b) => rank(a) - rank(b))[0]?.key;
}

function uniqueNames(names: Array<string | undefined>, limit: number): string[] | undefined {
  const out = names
    .map((n) => n?.trim())
    .filter((n): n is string => Boolean(n))
    .filter((n, i, all) => all.indexOf(n) === i)
    .slice(0, limit);
  return out.length > 0 ? out : undefined;
}

function usCertification(movie: TmdbMovie): string | undefined {
  const us = movie.release_dates?.results?.find((r) => r.iso_3166_1 === 'US');
  return us?.release_dates?.map((d) => d.certification?.trim()).find(Boolean) || undefined;
}

function ratingOf(movie: TmdbMovie): { rating?: number; ratingCount?: number } {
  if (typeof movie.vote_average !== 'number' || !(movie.vote_count && movie.vote_count > 0)) {
    return {};
  }
  return { rating: Math.round(movie.vote_average * 10) / 10, ratingCount: movie.vote_count };
}

function isoDate(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/** Pure mapping from a TMDB movie (with videos, credits and release_dates appended) to item fields. */
export function movieToFields(movie: TmdbMovie): Partial<MediaItemInput> {
  const releaseDate = isoDate(movie.release_date);
  const cast = [...(movie.credits?.cast ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const fields: Partial<MediaItemInput> = {
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : undefined,
    releaseDate,
    synopsis: movie.overview?.trim().slice(0, 4000) || undefined,
    tagline: movie.tagline?.trim().slice(0, 300) || undefined,
    runtimeMinutes: movie.runtime && movie.runtime > 0 ? Math.round(movie.runtime) : undefined,
    directors: uniqueNames(
      (movie.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name),
      10,
    ),
    featuring: uniqueNames(
      cast.map((c) => c.name),
      MAX_FEATURING,
    ),
    genres: uniqueNames(
      (movie.genres ?? []).map((g) => g.name),
      10,
    ),
    ...ratingOf(movie),
    contentRating: usCertification(movie),
    originalLanguage: /^[a-z]{2,3}$/.test(movie.original_language ?? '')
      ? movie.original_language
      : undefined,
    trailerYoutubeId: pickTrailer(movie),
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Partial<MediaItemInput>;
}

type WatchLinks = NonNullable<MediaItemInput['watchLinks']>;

/** Curated links (an official free stream) stay first; providers follow, never duplicating a URL. */
export function mergeWatchLinks(
  curated: WatchLinks | undefined,
  providers: WatchLinks,
): WatchLinks {
  const out: WatchLinks = [...(curated ?? [])];
  const seen = new Set(out.map((l) => l.url));
  for (const link of providers) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
  }
  return out.slice(0, 20);
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
  const movie = await tmdbGet<TmdbMovie>(`/movie/${tmdbId}`, key, APPEND);
  const providers = await tmdbGet<TmdbProviders>(`/movie/${tmdbId}/watch/providers`, key);
  const posterKey = movie.poster_path
    ? await uploadImage(ctx, s3, `media/posters/${tmdbId}.jpg`, movie.poster_path, POSTER_SIZE)
    : undefined;
  const backdropKey = movie.backdrop_path
    ? await uploadImage(
        ctx,
        s3,
        `media/backdrops/${tmdbId}.jpg`,
        movie.backdrop_path,
        BACKDROP_SIZE,
      )
    : undefined;
  const fields = movieToFields(movie);
  const links = providersToWatchLinks(providers);
  // TMDB fills what the curated row left empty; a curated year, synopsis or trailer wins.
  return {
    ...fields,
    ...item,
    year: item.year ?? fields.year,
    synopsis: item.synopsis || fields.synopsis,
    trailerYoutubeId: item.trailerYoutubeId ?? fields.trailerYoutubeId,
    posterKey: posterKey ?? item.posterKey,
    backdropKey: backdropKey ?? item.backdropKey,
    watchLinks: mergeWatchLinks(item.watchLinks, links),
    tags: withAttribution(item.tags),
  };
}

async function enrichBatch(
  ctx: ScriptContext,
  s3: S3Client | null,
  apiKey: string,
  batch: Batch,
): Promise<MediaItemInput[]> {
  const enriched: MediaItemInput[] = [];
  for (const item of batch.items) {
    if (!item.externalIds?.tmdb) continue;
    try {
      enriched.push(await enrich(ctx, s3, apiKey, item));
    } catch (err) {
      ctx.logger.warn({ source: batch.source, sourceId: item.sourceId, err }, 'skipped');
    }
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
  return enriched;
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const apiKey = ctx.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY is not set');
  const file = dataPath(argValue(ctx.args, 'input') ?? 'generated/media-wikidata.json');
  const batches = readBatches(readJson<unknown>(file));
  const candidates = batches.reduce(
    (n, b) => n + b.items.filter((i) => i.externalIds?.tmdb).length,
    0,
  );
  ctx.logger.info({ file, batches: batches.length, candidates }, 'tmdb enrichment');
  const s3 = ctx.env.S3_MEDIA_BUCKET ? new S3Client({ region: ctx.env.AWS_REGION }) : null;

  const totals = emptyTotals();
  let posters = 0;
  for (const batch of batches) {
    const enriched = await enrichBatch(ctx, s3, apiKey, batch);
    if (enriched.length === 0) continue;
    posters += enriched.filter((i) => i.posterKey).length;
    addTotals(totals, await postIngest(ctx, 'media', batch.source, enriched));
  }
  ctx.logger.info({ ...totals, posters }, 'done');
}

if (isMain(import.meta.url)) runScript(main);
