import { afterCursor, type Page, toPage } from '../lib/cursor.js';
import { type KeysetField, keysetFilter, keysetPage, keysetSort } from '../lib/keyset.js';
import { uniqueSlug } from '../lib/slug.js';
import type { HomeArea, PlaceType, VeganLevel } from '../models/enums.js';
import { type Place, type PlaceDoc, PlaceModel, type Types } from '../models/index.js';

export const MAP_PINS_LIMIT = 1000;

/** Filters shared by the list and the map pins. Defaults follow spec section 9. */
export interface PlaceFilters {
  bbox: [number, number, number, number];
  /** `full` by default: the map leans into fully vegan places. */
  veganLevel: VeganLevel | 'all';
  types?: PlaceType[];
  /** Chains are demoted and hidden unless asked for; never removed. */
  includeChains: boolean;
  q?: string;
}

export interface ListPlacesQuery extends PlaceFilters {
  cursor?: string;
  limit: number;
}

export interface SubmitPlaceInput {
  name: string;
  type: PlaceType;
  veganLevel: VeganLevel;
  location: { lng: number; lat: number };
  address?: string;
  city?: string;
  area?: HomeArea;
  website?: string;
  hours?: string;
  tags?: string[];
  description?: string;
  photoKeys?: string[];
}

type PlaceRow = Place & { _id: Types.ObjectId };

/**
 * The public ranking: fully vegan first, independents before chains, then the
 * most reviewed, then by name. `_id` breaks the remaining ties for the cursor.
 */
const RANKING: KeysetField[] = [
  { field: 'veganLevel', direction: 1 },
  { field: 'chain', direction: 1 },
  { field: 'reviewCount', direction: -1 },
  { field: 'name', direction: 1 },
];

/** What any client may see about a place. `submittedBy` and `adminEdited` never leave the server. */
export function toPublicPlace(doc: PlaceRow | PlaceDoc) {
  const p = 'toObject' in doc ? (doc.toObject() as PlaceRow) : doc;
  return {
    id: p._id.toHexString(),
    name: p.name,
    slug: p.slug,
    type: p.type,
    veganLevel: p.veganLevel,
    chain: p.chain ?? false,
    location: { lng: p.location.coordinates[0], lat: p.location.coordinates[1] },
    address: p.address,
    city: p.city,
    postcode: p.postcode ?? null,
    area: p.area,
    website: p.website ?? null,
    phone: p.phone ?? null,
    hours: p.hours ?? null,
    tags: p.tags,
    description: p.description,
    photoKeys: p.photoKeys,
    approvalStatus: p.approvalStatus,
    source: p.source,
    sourceId: p.sourceId ?? null,
    sourceUrl: p.sourceUrl ?? null,
    lastSeenAt: p.lastSeenAt ?? null,
    ratingAvg: p.ratingAvg,
    reviewCount: p.reviewCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export type PublicPlace = ReturnType<typeof toPublicPlace>;

/** The slim shape the map draws: enough to place and colour a pin, nothing else. */
export function toMapPin(p: PlaceRow) {
  return {
    id: p._id.toHexString(),
    slug: p.slug,
    name: p.name,
    type: p.type,
    veganLevel: p.veganLevel,
    chain: p.chain ?? false,
    location: { lng: p.location.coordinates[0], lat: p.location.coordinates[1] },
  };
}

export type MapPin = ReturnType<typeof toMapPin>;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bboxPolygon([w, s, e, n]: PlaceFilters['bbox']) {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

function approvedFilter(query: PlaceFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    approvalStatus: 'approved',
    location: { $geoWithin: { $geometry: bboxPolygon(query.bbox) } },
  };
  if (query.veganLevel !== 'all') filter.veganLevel = query.veganLevel;
  if (query.types && query.types.length > 0) filter.type = { $in: query.types };
  if (!query.includeChains) filter.chain = { $ne: true };
  if (query.q) filter.name = { $regex: escapeRegex(query.q), $options: 'i' };
  return filter;
}

/** Approved places inside a bounding box, ranked. Nothing about the caller is recorded. */
export async function listApprovedPlaces(query: ListPlacesQuery): Promise<Page<PublicPlace>> {
  const filter = { ...approvedFilter(query), ...keysetFilter(RANKING, query.cursor) };
  const rows = await PlaceModel.find(filter)
    .sort(keysetSort(RANKING))
    .limit(query.limit + 1)
    .lean<PlaceRow[]>();
  const page = keysetPage(rows, query.limit, RANKING);
  return { items: page.items.map(toPublicPlace), nextCursor: page.nextCursor };
}

/**
 * Up to `MAP_PINS_LIMIT` pins for the map in ranking order, so when a bbox
 * holds more than fit, the fully vegan independents are the ones drawn.
 */
export async function listMapPins(
  query: PlaceFilters,
): Promise<{ items: MapPin[]; truncated: boolean }> {
  const rows = await PlaceModel.find(approvedFilter(query))
    .sort(keysetSort(RANKING))
    .limit(MAP_PINS_LIMIT + 1)
    .select('slug name type veganLevel chain location')
    .lean<PlaceRow[]>();
  const truncated = rows.length > MAP_PINS_LIMIT;
  return { items: (truncated ? rows.slice(0, MAP_PINS_LIMIT) : rows).map(toMapPin), truncated };
}

export async function getApprovedPlaceBySlug(slug: string): Promise<PublicPlace | null> {
  const row = await PlaceModel.findOne({ slug, approvalStatus: 'approved' }).lean<PlaceRow>();
  return row ? toPublicPlace(row) : null;
}

/** Member submissions land in the moderation queue as `pending`. */
export async function submitPlace(
  input: SubmitPlaceInput,
  submittedBy: Types.ObjectId,
): Promise<PublicPlace> {
  const doc = await PlaceModel.create({
    ...input,
    location: { type: 'Point', coordinates: [input.location.lng, input.location.lat] },
    slug: await uniqueSlug(PlaceModel, input.name),
    approvalStatus: 'pending',
    source: 'user',
    submittedBy,
  });
  return toPublicPlace(doc);
}

export async function listPendingPlaces(query: {
  cursor?: string;
  limit: number;
}): Promise<Page<PublicPlace>> {
  const rows = await PlaceModel.find({ approvalStatus: 'pending', ...afterCursor(query.cursor) })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<PlaceRow[]>();
  const page = toPage(rows, query.limit);
  return { items: page.items.map(toPublicPlace), nextCursor: page.nextCursor };
}

export async function setPlaceApproval(
  id: Types.ObjectId,
  approvalStatus: 'approved' | 'rejected',
): Promise<PublicPlace | null> {
  const row = await PlaceModel.findOneAndUpdate(
    { _id: id },
    { $set: { approvalStatus }, $addToSet: { adminEdited: 'approvalStatus' } },
    { returnDocument: 'after' },
  ).lean<PlaceRow>();
  return row ? toPublicPlace(row) : null;
}
