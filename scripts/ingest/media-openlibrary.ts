/**
 * Ingest books about veganism and animal rights from the Open Library search
 * API. The catalogue metadata is CC0.
 *
 *   npm run ingest:media:openlibrary -- --dry-run   # search, map, print counts
 *   npm run ingest:media:openlibrary                # POST with INGEST_KEY
 *
 * Each work becomes a `book`: title, authors, year, one ISBN, and an outbound
 * link to the Open Library work page. New rows land as drafts unless
 * `openlibrary` is listed in TRUSTED_SOURCES. A re-run upserts by
 * `(source, sourceId)` and never deletes.
 *
 * Covers are downloaded from covers.openlibrary.org and uploaded to
 * `S3_MEDIA_BUCKET` under `media/posters/<workId>.jpg` (EXIF and XMP stripped).
 * The API only ever receives that key. A cover already in the bucket is not
 * downloaded again. When the bucket is not configured, covers are skipped.
 *
 * Requests carry a descriptive User-Agent and wait a second between calls,
 * including cover downloads. Open Library asks for that pace, and for an
 * identified client, so a refresh does not trip their limit.
 */
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { MEDIA_YEAR_MAX, MEDIA_YEAR_MIN } from '../../src/models/index.js';
import type { MediaItemInput } from '../../src/services/ingest.js';
import { isMain, postIngest, runScript, scriptContext } from './lib/client.js';
import { stripJpegMetadata } from './lib/jpeg.js';

export const OPEN_LIBRARY_SOURCE = 'openlibrary';
export const OPEN_LIBRARY_USER_AGENT =
  'vegan-grove-ingest/0.1 (+https://vegangrove.org; Open Library book ingest)';

export const SUBJECTS = [
  { q: 'subject:veganism', tag: 'veganism' },
  { q: 'subject:"animal rights"', tag: 'animal-rights' },
] as const;

const SEARCH_URL = 'https://openlibrary.org/search.json';
const SEARCH_FIELDS = 'key,title,author_name,first_publish_year,isbn,cover_i';
const PAGE_SIZE = 100;
/** 2,500 works per subject. Today's counts sit near 1,600; the cap is the runaway stop. */
const MAX_PAGES = 25;
const PACE_MS = 1_000;
const COVER_MIN_BYTES = 500;
const MAX_AUTHORS = 10;

export interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  cover_i?: number;
}

interface SearchBody {
  numFound?: number;
  num_found?: number;
  docs?: OpenLibraryDoc[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CoverStore {
  has(key: string): Promise<boolean>;
  put(key: string, body: Buffer): Promise<void>;
}

export interface MappedBook {
  item: MediaItemInput;
  coverId?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One second between calls. The first call does not wait. */
export function createPacer(ms = PACE_MS): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + ms;
    if (wait > 0) await sleep(wait);
  };
}

export function searchUrl(query: string, limit: number, offset: number): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('fields', SEARCH_FIELDS);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  return url.toString();
}

export function coverFetchUrl(coverId: number): string {
  return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
}

export function coverObjectKey(workId: string): string {
  return `media/posters/${workId}.jpg`;
}

const WORK_KEY = /OL\d{1,16}W$/;

export function workIdFromKey(key: string | undefined): string | null {
  if (!key) return null;
  return WORK_KEY.exec(key.trim())?.[0] ?? null;
}

function isbn13ok(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += (value.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

function isbn10ok(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = value[i];
    const digit = char === 'X' ? 10 : (char?.charCodeAt(0) ?? 0) - 48;
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

/** Prefer a valid ISBN-13, then a valid ISBN-10. Hyphens and spaces are ignored. */
export function pickIsbn(values: string[] | undefined): string | undefined {
  const isbn13: string[] = [];
  const isbn10: string[] = [];
  for (const raw of values ?? []) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (isbn13ok(cleaned)) isbn13.push(cleaned);
    else if (isbn10ok(cleaned)) isbn10.push(cleaned);
  }
  return isbn13[0] ?? isbn10[0];
}

function cleanAuthors(names: string[] | undefined): string[] | undefined {
  const out: string[] = [];
  for (const raw of names ?? []) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().replace(/\s+/g, ' ').slice(0, 100).trim();
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length === MAX_AUTHORS) break;
  }
  return out.length > 0 ? out : undefined;
}

function yearOf(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < MEDIA_YEAR_MIN || value > MEDIA_YEAR_MAX) return undefined;
  return value;
}

function coverIdOf(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** One search hit to one book. No remote image URL is stored. */
export function docToMapped(doc: OpenLibraryDoc, tag: string): MappedBook | null {
  const sourceId = workIdFromKey(doc.key);
  const title = doc.title?.trim().replace(/\s+/g, ' ');
  if (!sourceId || !title) return null;
  const isbn = pickIsbn(doc.isbn);
  const authors = cleanAuthors(doc.author_name);
  const year = yearOf(doc.first_publish_year);
  const item: MediaItemInput = {
    sourceId,
    title: title.slice(0, 160),
    kind: 'book',
    tags: ['open-library', tag],
    externalIds: { openLibrary: sourceId, ...(isbn ? { isbn } : {}) },
    sourceUrl: `https://openlibrary.org/works/${sourceId}`,
    ...(authors ? { authors } : {}),
    ...(year ? { year } : {}),
  };
  return { item, coverId: coverIdOf(doc.cover_i) };
}

/** Fill blanks on a work already seen under another subject. */
function absorb(existing: MappedBook, mapped: MappedBook, tag: string): void {
  const tags = existing.item.tags ?? [];
  if (!tags.includes(tag)) existing.item.tags = [...tags, tag];
  existing.coverId ??= mapped.coverId;
  existing.item.year ??= mapped.item.year;
  existing.item.authors ??= mapped.item.authors;
  const isbn = mapped.item.externalIds?.isbn;
  if (isbn && existing.item.externalIds && !existing.item.externalIds.isbn) {
    existing.item.externalIds = { ...existing.item.externalIds, isbn };
  }
}

/** One item per work. A work found under both subjects keeps both topic tags. */
export function mergeSubjects(
  groups: Array<{ tag: string; docs: OpenLibraryDoc[] }>,
): MappedBook[] {
  const byId = new Map<string, MappedBook>();
  for (const group of groups) {
    for (const doc of group.docs) {
      const mapped = docToMapped(doc, group.tag);
      if (!mapped) continue;
      const existing = byId.get(mapped.item.sourceId);
      if (existing) absorb(existing, mapped, group.tag);
      else byId.set(mapped.item.sourceId, mapped);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.item.title.localeCompare(b.item.title));
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

interface Retryable {
  retry: string;
  status: number;
  retryAfter: number;
}

function retryWait(retryAfter: number, attempt: number): number {
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * (attempt + 1);
}

async function fetchSearch(url: string, fetchImpl: FetchLike): Promise<SearchBody | Retryable> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': OPEN_LIBRARY_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return (await res.json()) as SearchBody;
  await res.arrayBuffer().catch(() => undefined);
  return {
    retry: `HTTP ${res.status}`,
    status: res.status,
    retryAfter: Number(res.headers.get('retry-after')),
  };
}

async function readSearch(
  url: string,
  fetchImpl: FetchLike,
  pace: () => Promise<void>,
): Promise<SearchBody> {
  let last = 'network';
  for (let attempt = 0; attempt < 3; attempt++) {
    await pace();
    try {
      const outcome = await fetchSearch(url, fetchImpl);
      if (!('retry' in outcome)) return outcome;
      last = outcome.retry;
      if (outcome.status !== 429 && outcome.status < 500) {
        throw new Error(`Open Library search ${last}`);
      }
      await sleep(retryWait(outcome.retryAfter, attempt));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Open Library search HTTP')) throw err;
      last = err instanceof Error ? err.message : 'network';
      await sleep(2_000 * (attempt + 1));
    }
  }
  throw new Error(`Open Library search failed (${last})`);
}

export async function searchSubject(
  query: string,
  options: {
    fetchImpl?: FetchLike;
    pace?: () => Promise<void>;
    maxPages?: number;
    pageSize?: number;
  } = {},
): Promise<{ docs: OpenLibraryDoc[]; truncated: boolean }> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const pace = options.pace ?? createPacer();
  const maxPages = options.maxPages ?? MAX_PAGES;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const docs: OpenLibraryDoc[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < maxPages; page++) {
    const body = await readSearch(searchUrl(query, pageSize, page * pageSize), fetchImpl, pace);
    const batch = Array.isArray(body.docs) ? body.docs : [];
    total = body.num_found ?? body.numFound ?? total;
    docs.push(...batch);
    if (batch.length < pageSize || docs.length >= total) return { docs, truncated: false };
  }
  return { docs, truncated: docs.length < total };
}

export async function downloadCover(url: string, fetchImpl: FetchLike): Promise<Buffer | null> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': OPEN_LIBRARY_USER_AGENT, Accept: 'image/jpeg' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    return null;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < COVER_MIN_BYTES || body[0] !== 0xff || body[1] !== 0xd8) return null;
  const stripped = stripJpegMetadata(body);
  if (stripped[0] !== 0xff || stripped[1] !== 0xd8) return null;
  return stripped;
}

interface CoverOptions {
  dryRun: boolean;
  store: CoverStore | null;
  fetchImpl: FetchLike;
  pace: () => Promise<void>;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** Download and store one cover. Returns the object key, or undefined when the image is unusable. */
async function storeCover(
  book: MappedBook,
  key: string,
  options: CoverOptions,
): Promise<string | undefined> {
  const store = options.store;
  const coverId = book.coverId;
  if (!store || !coverId) return undefined;
  if (await store.has(key)) return key;
  await options.pace();
  const body = await downloadCover(coverFetchUrl(coverId), options.fetchImpl);
  if (!body) return undefined;
  await store.put(key, body);
  return key;
}

async function coverItem(book: MappedBook, options: CoverOptions): Promise<MediaItemInput> {
  if (!book.coverId || !options.store) return book.item;
  const key = coverObjectKey(book.item.sourceId);
  if (options.dryRun) return { ...book.item, posterKey: key };
  const posterKey = await storeCover(book, key, options);
  if (!posterKey) options.warn({ sourceId: book.item.sourceId }, 'cover skipped');
  return posterKey ? { ...book.item, posterKey } : book.item;
}

export async function attachCovers(
  books: MappedBook[],
  options: CoverOptions,
): Promise<MediaItemInput[]> {
  const items: MediaItemInput[] = [];
  let skipped = 0;
  for (const book of books) {
    if (book.coverId && !options.store) skipped += 1;
    try {
      items.push(await coverItem(book, options));
    } catch (err) {
      options.warn(
        { sourceId: book.item.sourceId, err: err instanceof Error ? err.message : String(err) },
        'cover skipped',
      );
      items.push(book.item);
    }
  }
  if (skipped > 0) options.warn({ covers: skipped }, 'S3_MEDIA_BUCKET not set; covers skipped');
  return items;
}

function isMissingObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String(err.name) : '';
  const meta = '$metadata' in err ? err.$metadata : undefined;
  const status =
    meta && typeof meta === 'object' && 'httpStatusCode' in meta ? Number(meta.httpStatusCode) : 0;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

function s3Store(s3: S3Client, bucket: string): CoverStore {
  return {
    async has(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if (isMissingObject(err)) return false;
        throw err;
      }
    },
    async put(key, body) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    },
  };
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const pace = createPacer();
  const groups: Array<{ tag: string; docs: OpenLibraryDoc[] }> = [];
  for (const subject of SUBJECTS) {
    ctx.logger.info({ subject: subject.tag }, 'searching Open Library');
    const { docs, truncated } = await searchSubject(subject.q, { pace });
    if (truncated) ctx.logger.warn({ subject: subject.tag }, 'subject truncated at the page cap');
    ctx.logger.info({ subject: subject.tag, works: docs.length }, 'search page complete');
    groups.push({ tag: subject.tag, docs });
  }
  const books = mergeSubjects(groups);
  const store = ctx.env.S3_MEDIA_BUCKET
    ? s3Store(new S3Client({ region: ctx.env.AWS_REGION }), ctx.env.S3_MEDIA_BUCKET)
    : null;
  const items = await attachCovers(books, {
    dryRun: ctx.dryRun,
    store,
    fetchImpl: defaultFetch,
    pace,
    warn: (obj, msg) => ctx.logger.warn(obj, msg),
  });
  const totals = await postIngest(ctx, 'media', OPEN_LIBRARY_SOURCE, items);
  ctx.logger.info(
    { ...totals, books: items.length, covers: items.filter((item) => item.posterKey).length },
    'done',
  );
}

if (isMain(import.meta.url)) runScript(main);
