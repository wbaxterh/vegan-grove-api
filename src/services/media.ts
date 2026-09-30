import { createHash } from 'node:crypto';
import { afterCursor, type Page, toPage } from '../lib/cursor.js';
import { notFound } from '../lib/errors.js';
import { type KeysetField, keysetFilter, keysetPage, keysetSort } from '../lib/keyset.js';
import { slugify } from '../lib/slug.js';
import {
  MEDIA_TOPIC_TAGS,
  type MediaCollection,
  MediaCollectionModel,
  type MediaItem,
  MediaItemModel,
  MediaReactionModel,
  type MediaReactionType,
  SavedMediaModel,
  type Types,
} from '../models/index.js';

/**
 * The media library (spec section 10). Every read here is public data by
 * construction: unpublished rows never leave, counts are aggregate, and the
 * only per-member state (saved, reacted) is answered to that member alone.
 * Nothing records what anyone watched.
 */

type MediaRow = MediaItem & { _id: Types.ObjectId };
type CollectionRow = MediaCollection & { _id: Types.ObjectId };

export interface MediaReadOptions {
  cdnOrigin?: string;
}

export const MEDIA_SORTS = ['featured', 'release', 'title', 'rating', 'runtime'] as const;
export type MediaSort = (typeof MEDIA_SORTS)[number];

const SORT_FIELDS: Record<MediaSort, KeysetField[]> = {
  featured: [
    { field: 'featured', direction: -1 },
    { field: '_id', direction: -1 },
  ],
  release: [
    { field: 'year', direction: -1 },
    { field: '_id', direction: -1 },
  ],
  title: [
    { field: 'title', direction: 1 },
    { field: '_id', direction: 1 },
  ],
  rating: [
    { field: 'rating', direction: -1 },
    { field: '_id', direction: -1 },
  ],
  runtime: [
    { field: 'runtimeMinutes', direction: 1 },
    { field: '_id', direction: 1 },
  ],
};

const ROW_LIMIT = 12;
const HERO_LIMIT = 6;
const SHORT_MINUTES = 30;
/** Attribution tags ride on enriched rows; they are not topics and never drive "related". */
const ATTRIBUTION_TAGS = new Set([
  'tmdb',
  'wikidata',
  'curated',
  'Watch providers data by JustWatch',
]);

const PUBLISHED = { status: 'published' } as const;

/** An S3 key as a public URL on the media CDN, or `null` until the CDN exists. */
export function mediaAssetUrl(key: string | null | undefined, cdnOrigin?: string): string | null {
  if (!key || !cdnOrigin) return null;
  return `${cdnOrigin.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

function publicWatchLinks(m: MediaRow) {
  return m.watchLinks.map((w) => ({
    provider: w.provider,
    url: w.url,
    access: w.access ?? 'unknown',
  }));
}

function publicActions(m: MediaRow) {
  return (m.actions ?? []).map((a) => ({
    label: a.label,
    url: a.url,
    type: a.type,
    org: a.org ?? null,
  }));
}

function publicStats(m: MediaRow) {
  return {
    saves: m.stats?.saves ?? 0,
    moved: m.stats?.moved ?? 0,
    acted: m.stats?.acted ?? 0,
  };
}

/** Nullable scalars as `null`, arrays as `[]`, so clients never branch on `undefined`. */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function toPublicMedia(m: MediaRow, options: MediaReadOptions = {}) {
  return {
    id: m._id.toHexString(),
    title: m.title,
    slug: m.slug,
    kind: m.kind,
    year: orNull(m.year),
    releaseDate: orNull(m.releaseDate),
    synopsis: m.synopsis,
    tagline: orNull(m.tagline),
    posterKey: orNull(m.posterKey),
    posterUrl: mediaAssetUrl(m.posterKey, options.cdnOrigin),
    backdropUrl: mediaAssetUrl(m.backdropKey, options.cdnOrigin),
    runtimeMinutes: orNull(m.runtimeMinutes),
    contentRating: orNull(m.contentRating),
    originalLanguage: orNull(m.originalLanguage),
    directors: m.directors ?? [],
    featuring: m.featuring ?? [],
    genres: m.genres ?? [],
    tags: m.tags,
    contentWarnings: m.contentWarnings ?? [],
    rating: orNull(m.rating),
    ratingCount: orNull(m.ratingCount),
    watchLinks: publicWatchLinks(m),
    trailerYoutubeId: orNull(m.trailerYoutubeId),
    officialSite: orNull(m.officialSite),
    actions: publicActions(m),
    externalIds: m.externalIds ?? {},
    featured: m.featured,
    sourceUrl: orNull(m.sourceUrl),
    createdAt: m.createdAt,
    stats: publicStats(m),
  };
}

export type PublicMedia = ReturnType<typeof toPublicMedia>;

/** Admin view: the public shape plus what moderation needs to see. */
export function toAdminMedia(m: MediaRow, options: MediaReadOptions = {}) {
  return {
    ...toPublicMedia(m, options),
    status: m.status,
    source: m.source,
    sourceId: m.sourceId,
    adminEdited: m.adminEdited ?? [],
    updatedAt: m.updatedAt,
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchClause(q: string): Record<string, unknown> {
  const re = new RegExp(escapeRegex(q.trim()), 'i');
  return {
    $or: [
      { title: re },
      { tagline: re },
      { synopsis: re },
      { directors: re },
      { featuring: re },
      { tags: re },
      { genres: re },
    ],
  };
}

export interface MediaListQuery {
  q?: string;
  kind?: MediaItem['kind'];
  tag?: string;
  year?: number;
  free?: boolean;
  maxRuntime?: number;
  sort?: MediaSort;
  cursor?: string;
  limit: number;
}

export async function listMedia(
  query: MediaListQuery,
  options: MediaReadOptions = {},
): Promise<Page<PublicMedia>> {
  const sort = query.sort ?? 'featured';
  const fields = SORT_FIELDS[sort];
  const clauses: Record<string, unknown>[] = [PUBLISHED, keysetFilter(fields, query.cursor)];
  if (query.kind) clauses.push({ kind: query.kind });
  if (query.tag) clauses.push({ tags: query.tag });
  if (query.year) clauses.push({ year: query.year });
  if (query.free) clauses.push({ 'watchLinks.access': 'free' });
  if (query.maxRuntime) clauses.push({ runtimeMinutes: { $lte: query.maxRuntime } });
  // A runtime order only makes sense over titles whose runtime is known.
  if (sort === 'runtime') clauses.push({ runtimeMinutes: { $ne: null } });
  if (query.q) clauses.push(searchClause(query.q));
  const rows = await MediaItemModel.find({ $and: clauses })
    .sort(keysetSort(fields))
    .limit(query.limit + 1)
    .lean<MediaRow[]>();
  const page = keysetPage(rows, query.limit, fields);
  return { items: page.items.map((m) => toPublicMedia(m, options)), nextCursor: page.nextCursor };
}

export async function getMediaBySlug(
  slug: string,
  options: MediaReadOptions = {},
): Promise<PublicMedia | null> {
  const row = await MediaItemModel.findOne({ slug, ...PUBLISHED }).lean<MediaRow>();
  return row ? toPublicMedia(row, options) : null;
}

export interface MediaViewer {
  saved: boolean;
  reactions: MediaReactionType[];
}

/** What this member has done with this title. Only ever answered to that member. */
export async function getViewer(mediaId: string, userId: Types.ObjectId): Promise<MediaViewer> {
  const [saved, reactions] = await Promise.all([
    SavedMediaModel.exists({ mediaId, userId }),
    MediaReactionModel.find({ mediaId, userId })
      .select('type')
      .lean<{ type: MediaReactionType }[]>(),
  ]);
  return { saved: Boolean(saved), reactions: reactions.map((r) => r.type).sort() };
}

function topicTags(tags: string[]): string[] {
  return tags.filter((t) => !ATTRIBUTION_TAGS.has(t));
}

/** Titles sharing a topic tag or a genre, most shared first, newest breaking ties. */
export async function relatedMedia(
  slug: string,
  limit = ROW_LIMIT,
  options: MediaReadOptions = {},
): Promise<PublicMedia[] | null> {
  const item = await MediaItemModel.findOne({ slug, ...PUBLISHED }).lean<MediaRow>();
  if (!item) return null;
  const tags = topicTags(item.tags);
  const genres = item.genres ?? [];
  if (tags.length === 0 && genres.length === 0) return [];
  const candidates = await MediaItemModel.find({
    ...PUBLISHED,
    _id: { $ne: item._id },
    $or: [{ tags: { $in: tags } }, { genres: { $in: genres } }],
  })
    .sort({ _id: -1 })
    .limit(80)
    .lean<MediaRow[]>();
  const score = (c: MediaRow) =>
    topicTags(c.tags).filter((t) => tags.includes(t)).length * 2 +
    (c.genres ?? []).filter((g) => genres.includes(g)).length;
  return candidates
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s || b.c._id.toString().localeCompare(a.c._id.toString()))
    .slice(0, limit)
    .map(({ c }) => toPublicMedia(c, options));
}

/** Rows keep the editor's order; unpublished members simply drop out. */
async function collectionItems(
  itemIds: Types.ObjectId[],
  limit: number | null,
  options: MediaReadOptions,
): Promise<PublicMedia[]> {
  if (itemIds.length === 0) return [];
  const rows = await MediaItemModel.find({ _id: { $in: itemIds }, ...PUBLISHED }).lean<
    MediaRow[]
  >();
  const byId = new Map(rows.map((r) => [r._id.toHexString(), r]));
  const ordered = itemIds
    .map((id) => byId.get(id.toHexString()))
    .filter((r): r is MediaRow => Boolean(r));
  return (limit ? ordered.slice(0, limit) : ordered).map((m) => toPublicMedia(m, options));
}

export function toPublicCollection(c: CollectionRow, items: PublicMedia[]) {
  return {
    id: c._id.toHexString(),
    slug: c.slug,
    name: c.name,
    description: c.description,
    order: c.order,
    items,
  };
}

export type PublicCollection = ReturnType<typeof toPublicCollection>;

export async function listCollections(
  options: MediaReadOptions = {},
  preview = 4,
): Promise<PublicCollection[]> {
  const rows = await MediaCollectionModel.find({ published: true })
    .sort({ order: 1, name: 1 })
    .lean<CollectionRow[]>();
  return Promise.all(
    rows.map(async (c) =>
      toPublicCollection(c, await collectionItems(c.itemIds, preview, options)),
    ),
  );
}

export async function getCollectionBySlug(
  slug: string,
  options: MediaReadOptions = {},
): Promise<PublicCollection | null> {
  const row = await MediaCollectionModel.findOne({ slug, published: true }).lean<CollectionRow>();
  if (!row) return null;
  return toPublicCollection(row, await collectionItems(row.itemIds, null, options));
}

export interface HomeRow {
  key: string;
  name: string;
  description: string | null;
  kind: 'collection' | 'auto';
  slug: string | null;
  items: PublicMedia[];
}

/** Same order for every client on a given UTC day; backdrops lead because the hero needs one. */
function heroOrder(rows: MediaRow[], day: string): MediaRow[] {
  const rank = (r: MediaRow) =>
    createHash('sha1').update(`${day}:${r._id.toHexString()}`).digest('hex');
  return rows
    .map((r) => ({ r, h: rank(r), hasBackdrop: Boolean(r.backdropKey) }))
    .sort((a, b) => Number(b.hasBackdrop) - Number(a.hasBackdrop) || a.h.localeCompare(b.h))
    .map(({ r }) => r);
}

const AUTO_ROWS: Array<{
  key: string;
  name: string;
  description: string;
  filter: Record<string, unknown>;
}> = [
  {
    key: 'auto:newest',
    name: 'New to the library',
    description: 'The latest additions.',
    filter: {},
  },
  {
    key: 'auto:free',
    name: 'Free to watch',
    description: 'Titles a provider offers at no charge.',
    filter: { 'watchLinks.access': 'free' },
  },
  {
    key: 'auto:short',
    name: 'Under 30 minutes',
    description: 'Something to send a friend tonight.',
    filter: { runtimeMinutes: { $lte: SHORT_MINUTES } },
  },
  ...MEDIA_TOPIC_TAGS.map((tag) => ({
    key: `auto:tag:${tag}`,
    name: tag.charAt(0).toUpperCase() + tag.slice(1),
    description: '',
    filter: { tags: tag },
  })),
];

export async function homeRows(
  options: MediaReadOptions = {},
  now = new Date(),
): Promise<{ hero: PublicMedia[]; rows: HomeRow[] }> {
  const day = now.toISOString().slice(0, 10);
  const [featured, collections] = await Promise.all([
    MediaItemModel.find({ ...PUBLISHED, featured: true })
      .sort({ _id: -1 })
      .limit(24)
      .lean<MediaRow[]>(),
    MediaCollectionModel.find({ published: true })
      .sort({ order: 1, name: 1 })
      .lean<CollectionRow[]>(),
  ]);
  const hero = heroOrder(featured, day)
    .slice(0, HERO_LIMIT)
    .map((m) => toPublicMedia(m, options));

  const rows: HomeRow[] = [];
  for (const c of collections) {
    const items = await collectionItems(c.itemIds, ROW_LIMIT, options);
    if (items.length === 0) continue;
    rows.push({
      key: `collection:${c.slug}`,
      name: c.name,
      description: c.description || null,
      kind: 'collection',
      slug: c.slug,
      items,
    });
  }
  for (const auto of AUTO_ROWS) {
    const items = await MediaItemModel.find({ ...PUBLISHED, ...auto.filter })
      .sort({ _id: -1 })
      .limit(ROW_LIMIT)
      .lean<MediaRow[]>();
    if (items.length < 2) continue;
    rows.push({
      key: auto.key,
      name: auto.name,
      description: auto.description || null,
      kind: 'auto',
      slug: null,
      items: items.map((m) => toPublicMedia(m, options)),
    });
  }
  return { hero, rows };
}

// ---- member state ----

async function publishedId(mediaId: string | Types.ObjectId): Promise<Types.ObjectId> {
  const row = await MediaItemModel.findOne({ _id: mediaId, ...PUBLISHED })
    .select('_id')
    .lean<{ _id: Types.ObjectId }>();
  if (!row) throw notFound('Media item not found.');
  return row._id;
}

export async function setSaved(
  mediaId: string | Types.ObjectId,
  userId: Types.ObjectId,
  saved: boolean,
): Promise<boolean> {
  const id = await publishedId(mediaId);
  if (saved) {
    const res = await SavedMediaModel.updateOne(
      { mediaId: id, userId },
      { $setOnInsert: { mediaId: id, userId } },
      { upsert: true },
    );
    if (res.upsertedCount)
      await MediaItemModel.updateOne({ _id: id }, { $inc: { 'stats.saves': 1 } });
  } else {
    const res = await SavedMediaModel.deleteOne({ mediaId: id, userId });
    if (res.deletedCount)
      await MediaItemModel.updateOne({ _id: id }, { $inc: { 'stats.saves': -1 } });
  }
  return saved;
}

export async function setReaction(
  mediaId: string | Types.ObjectId,
  userId: Types.ObjectId,
  type: MediaReactionType,
  on: boolean,
): Promise<{ stats: PublicMedia['stats']; viewer: MediaViewer }> {
  const id = await publishedId(mediaId);
  const counter = `stats.${type}`;
  if (on) {
    const res = await MediaReactionModel.updateOne(
      { mediaId: id, userId, type },
      { $setOnInsert: { mediaId: id, userId, type } },
      { upsert: true },
    );
    if (res.upsertedCount) await MediaItemModel.updateOne({ _id: id }, { $inc: { [counter]: 1 } });
  } else {
    const res = await MediaReactionModel.deleteOne({ mediaId: id, userId, type });
    if (res.deletedCount) await MediaItemModel.updateOne({ _id: id }, { $inc: { [counter]: -1 } });
  }
  const row = await MediaItemModel.findById(id).lean<MediaRow>();
  const stats = row ? toPublicMedia(row).stats : { saves: 0, moved: 0, acted: 0 };
  return { stats, viewer: await getViewer(id.toHexString(), userId) };
}

export async function listWatchlist(
  userId: Types.ObjectId,
  query: { cursor?: string; limit: number },
  options: MediaReadOptions = {},
): Promise<Page<PublicMedia>> {
  const saved = await SavedMediaModel.find({ userId, ...afterCursor(query.cursor) })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<Array<{ _id: Types.ObjectId; mediaId: Types.ObjectId }>>();
  const page = toPage(saved, query.limit);
  const items = await collectionItems(
    page.items.map((s) => s.mediaId),
    null,
    options,
  );
  return { items, nextCursor: page.nextCursor };
}

// ---- admin ----

export interface AdminMediaInput {
  title: string;
  kind: MediaItem['kind'];
  status?: MediaItem['status'];
  featured?: boolean;
  [key: string]: unknown;
}

async function freeSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base) || 'title';
  let slug = root;
  for (let n = 2; await taken(slug); n++) slug = `${root}-${n}`;
  return slug;
}

export async function adminListMedia(
  query: { status?: MediaItem['status']; q?: string; cursor?: string; limit: number },
  options: MediaReadOptions = {},
) {
  const clauses: Record<string, unknown>[] = [afterCursor(query.cursor)];
  if (query.status) clauses.push({ status: query.status });
  if (query.q) clauses.push(searchClause(query.q));
  const rows = await MediaItemModel.find({ $and: clauses })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<MediaRow[]>();
  const page = toPage(rows, query.limit);
  return { items: page.items.map((m) => toAdminMedia(m, options)), nextCursor: page.nextCursor };
}

/** Hand-entered titles: source `admin`, and every field given counts as an admin edit. */
export async function adminCreateMedia(input: AdminMediaInput, options: MediaReadOptions = {}) {
  const slug = await freeSlug(
    input.year ? `${input.title} ${input.year}` : input.title,
    async (s) => Boolean(await MediaItemModel.exists({ slug: s })),
  );
  const row = await MediaItemModel.create({
    ...input,
    slug,
    source: 'admin',
    sourceId: slug,
    adminEdited: Object.keys(input),
    lastSeenAt: new Date(),
  });
  return toAdminMedia(row.toObject() as MediaRow, options);
}

export async function adminUpdateMedia(
  id: string | Types.ObjectId,
  patch: Record<string, unknown>,
  options: MediaReadOptions = {},
) {
  const keys = Object.keys(patch);
  const row = await MediaItemModel.findOneAndUpdate(
    { _id: id },
    keys.length > 0 ? { $set: patch, $addToSet: { adminEdited: { $each: keys } } } : {},
    { new: true, runValidators: true },
  ).lean<MediaRow>();
  return row ? toAdminMedia(row, options) : null;
}

export async function adminDeleteMedia(id: string | Types.ObjectId): Promise<boolean> {
  const res = await MediaItemModel.deleteOne({ _id: id });
  if (!res.deletedCount) return false;
  await Promise.all([
    SavedMediaModel.deleteMany({ mediaId: id }),
    MediaReactionModel.deleteMany({ mediaId: id }),
    MediaCollectionModel.updateMany({ itemIds: id }, { $pull: { itemIds: id } }),
  ]);
  return true;
}

export function toAdminCollection(c: CollectionRow) {
  return {
    id: c._id.toHexString(),
    slug: c.slug,
    name: c.name,
    description: c.description,
    order: c.order,
    published: c.published,
    itemIds: c.itemIds.map((id) => id.toHexString()),
    updatedAt: c.updatedAt,
  };
}

export async function adminListCollections() {
  const rows = await MediaCollectionModel.find({})
    .sort({ order: 1, name: 1 })
    .lean<CollectionRow[]>();
  return rows.map(toAdminCollection);
}

export async function adminCreateCollection(input: {
  name: string;
  slug?: string;
  description?: string;
  order?: number;
  published?: boolean;
  itemIds?: string[];
}) {
  const slug = await freeSlug(input.slug ?? input.name, async (s) =>
    Boolean(await MediaCollectionModel.exists({ slug: s })),
  );
  const row = await MediaCollectionModel.create({ ...input, slug });
  return toAdminCollection(row.toObject() as CollectionRow);
}

export async function adminUpdateCollection(
  id: string | Types.ObjectId,
  patch: Record<string, unknown>,
) {
  const row = await MediaCollectionModel.findOneAndUpdate(
    { _id: id },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean<CollectionRow>();
  return row ? toAdminCollection(row) : null;
}
