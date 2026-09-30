import { afterCursor, type Page, toPage } from '../lib/cursor.js';
import { type KeysetField, keysetFilter, keysetPage, keysetSort } from '../lib/keyset.js';
import type { HomeArea } from '../models/enums.js';
import {
  type Grove,
  GroveModel,
  type Guide,
  GuideModel,
  type MediaItem,
  MediaItemModel,
  type Organization,
  OrganizationModel,
  type Types,
} from '../models/index.js';

/**
 * The public catalogue: organizations, groves, media and guides. Every read
 * here is public data by construction (spec section 3); the only thing to
 * get right is what stays behind: unpublished rows, org admin ids, and the
 * provenance bookkeeping.
 */

// ---- organizations ----

type OrganizationRow = Organization & { _id: Types.ObjectId };

/** Verified organizations first, then by name; `_id` breaks ties for the cursor. */
const ORGANIZATION_ORDER: KeysetField[] = [
  { field: 'verified', direction: -1 },
  { field: 'name', direction: 1 },
];

/** `adminUserIds` is the one field on an organization that is about people. Never serialized. */
export function toPublicOrganization(o: OrganizationRow) {
  return {
    id: o._id.toHexString(),
    name: o.name,
    slug: o.slug,
    type: o.type,
    description: o.description,
    website: o.website ?? null,
    socials: (o.socials ?? {}) as unknown as Record<string, string>,
    area: o.area ?? null,
    verified: o.verified,
    sourceUrl: o.sourceUrl ?? null,
    createdAt: o.createdAt,
  };
}

export type PublicOrganization = ReturnType<typeof toPublicOrganization>;

export async function listOrganizations(query: {
  type?: Organization['type'];
  cursor?: string;
  limit: number;
}): Promise<Page<PublicOrganization>> {
  const filter: Record<string, unknown> = { ...keysetFilter(ORGANIZATION_ORDER, query.cursor) };
  if (query.type) filter.type = query.type;
  const rows = await OrganizationModel.find(filter)
    .sort(keysetSort(ORGANIZATION_ORDER))
    .limit(query.limit + 1)
    .lean<OrganizationRow[]>();
  const page = keysetPage(rows, query.limit, ORGANIZATION_ORDER);
  return { items: page.items.map(toPublicOrganization), nextCursor: page.nextCursor };
}

export async function getOrganizationBySlug(slug: string): Promise<PublicOrganization | null> {
  const row = await OrganizationModel.findOne({ slug }).lean<OrganizationRow>();
  return row ? toPublicOrganization(row) : null;
}

// ---- groves ----

type GroveRow = Grove & { _id: Types.ObjectId };

const GROVE_ORDER: KeysetField[] = [{ field: 'name', direction: 1 }];

/** Membership is private; the count is the only thing said about the members. */
export function toPublicGrove(g: GroveRow) {
  return {
    id: g._id.toHexString(),
    name: g.name,
    slug: g.slug,
    area: g.area,
    description: g.description,
    memberCount: g.memberCount,
    createdAt: g.createdAt,
  };
}

export type PublicGrove = ReturnType<typeof toPublicGrove>;

export async function listGroves(query: {
  area?: HomeArea;
  cursor?: string;
  limit: number;
}): Promise<Page<PublicGrove>> {
  const filter: Record<string, unknown> = { ...keysetFilter(GROVE_ORDER, query.cursor) };
  if (query.area) filter.area = query.area;
  const rows = await GroveModel.find(filter)
    .sort(keysetSort(GROVE_ORDER))
    .limit(query.limit + 1)
    .lean<GroveRow[]>();
  const page = keysetPage(rows, query.limit, GROVE_ORDER);
  return { items: page.items.map(toPublicGrove), nextCursor: page.nextCursor };
}

export async function getGroveBySlug(slug: string): Promise<PublicGrove | null> {
  const row = await GroveModel.findOne({ slug }).lean<GroveRow>();
  return row ? toPublicGrove(row) : null;
}

// ---- media ----

type MediaRow = MediaItem & { _id: Types.ObjectId };

/** Featured first, then newest. */
const MEDIA_ORDER: KeysetField[] = [
  { field: 'featured', direction: -1 },
  { field: '_id', direction: -1 },
];

/** Options every media read takes: where images are served from, if anywhere yet. */
export interface MediaReadOptions {
  cdnOrigin?: string;
}

/** An S3 key as a public URL on the media CDN, or `null` until the CDN exists. */
export function mediaAssetUrl(key: string | null | undefined, cdnOrigin?: string): string | null {
  if (!key || !cdnOrigin) return null;
  return `${cdnOrigin.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

export function toPublicMedia(m: MediaRow, options: MediaReadOptions = {}) {
  return {
    id: m._id.toHexString(),
    title: m.title,
    slug: m.slug,
    kind: m.kind,
    year: m.year ?? null,
    synopsis: m.synopsis,
    tagline: m.tagline ?? null,
    posterKey: m.posterKey ?? null,
    posterUrl: mediaAssetUrl(m.posterKey, options.cdnOrigin),
    backdropUrl: mediaAssetUrl(m.backdropKey, options.cdnOrigin),
    runtimeMinutes: m.runtimeMinutes ?? null,
    releaseDate: m.releaseDate ?? null,
    directors: m.directors ?? [],
    featuring: m.featuring ?? [],
    genres: m.genres ?? [],
    rating: m.rating ?? null,
    ratingCount: m.ratingCount ?? null,
    contentRating: m.contentRating ?? null,
    originalLanguage: m.originalLanguage ?? null,
    watchLinks: m.watchLinks.map((w) => ({ provider: w.provider, url: w.url })),
    trailerYoutubeId: m.trailerYoutubeId ?? null,
    tags: m.tags,
    externalIds: m.externalIds ?? {},
    featured: m.featured,
    sourceUrl: m.sourceUrl ?? null,
    createdAt: m.createdAt,
  };
}

export type PublicMedia = ReturnType<typeof toPublicMedia>;

export async function listPublishedMedia(
  query: {
    kind?: MediaItem['kind'];
    tag?: string;
    cursor?: string;
    limit: number;
  },
  options: MediaReadOptions = {},
): Promise<Page<PublicMedia>> {
  const filter: Record<string, unknown> = {
    status: 'published',
    ...keysetFilter(MEDIA_ORDER, query.cursor),
  };
  if (query.kind) filter.kind = query.kind;
  if (query.tag) filter.tags = query.tag;
  const rows = await MediaItemModel.find(filter)
    .sort(keysetSort(MEDIA_ORDER))
    .limit(query.limit + 1)
    .lean<MediaRow[]>();
  const page = keysetPage(rows, query.limit, MEDIA_ORDER);
  return { items: page.items.map((m) => toPublicMedia(m, options)), nextCursor: page.nextCursor };
}

export async function getPublishedMediaBySlug(
  slug: string,
  options: MediaReadOptions = {},
): Promise<PublicMedia | null> {
  const row = await MediaItemModel.findOne({ slug, status: 'published' }).lean<MediaRow>();
  return row ? toPublicMedia(row, options) : null;
}

// ---- guides ----

type GuideRow = Guide & { _id: Types.ObjectId };

/** The list omits `body`: guides can be long and the list is for choosing one. */
export function toGuideSummary(g: GuideRow) {
  return {
    id: g._id.toHexString(),
    title: g.title,
    slug: g.slug,
    category: g.category,
    summary: g.summary,
    sources: g.sources.map((s) => ({ title: s.title, url: s.url, license: s.license ?? null })),
    sourceUrl: g.sourceUrl ?? null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

export function toPublicGuide(g: GuideRow) {
  return { ...toGuideSummary(g), body: g.body };
}

export type GuideSummary = ReturnType<typeof toGuideSummary>;
export type PublicGuide = ReturnType<typeof toPublicGuide>;

export async function listPublishedGuides(query: {
  category?: Guide['category'];
  cursor?: string;
  limit: number;
}): Promise<Page<GuideSummary>> {
  const filter: Record<string, unknown> = { status: 'published', ...afterCursor(query.cursor) };
  if (query.category) filter.category = query.category;
  const rows = await GuideModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .select('-body')
    .lean<GuideRow[]>();
  const page = toPage(rows, query.limit);
  return { items: page.items.map(toGuideSummary), nextCursor: page.nextCursor };
}

export async function getPublishedGuideBySlug(slug: string): Promise<PublicGuide | null> {
  const row = await GuideModel.findOne({ slug, status: 'published' }).lean<GuideRow>();
  return row ? toPublicGuide(row) : null;
}
