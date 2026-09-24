import { afterCursor, type Page, toPage } from '../lib/cursor.js';
import { uniqueSlug } from '../lib/slug.js';
import type { HomeArea, PlaceType } from '../models/enums.js';
import { type Place, type PlaceDoc, PlaceModel, type Types } from '../models/index.js';

export interface ListPlacesQuery {
  bbox: [number, number, number, number];
  type?: PlaceType;
  q?: string;
  cursor?: string;
  limit: number;
}

export interface SubmitPlaceInput {
  name: string;
  type: PlaceType;
  veganLevel: 'full' | 'options';
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

/** What any client may see about a place. `submittedBy` never leaves the server. */
export function toPublicPlace(doc: PlaceRow | PlaceDoc) {
  const p = 'toObject' in doc ? (doc.toObject() as PlaceRow) : doc;
  return {
    id: p._id.toHexString(),
    name: p.name,
    slug: p.slug,
    type: p.type,
    veganLevel: p.veganLevel,
    location: { lng: p.location.coordinates[0], lat: p.location.coordinates[1] },
    address: p.address,
    city: p.city,
    area: p.area,
    website: p.website ?? null,
    hours: p.hours ?? null,
    tags: p.tags,
    description: p.description,
    photoKeys: p.photoKeys,
    approvalStatus: p.approvalStatus,
    source: p.source,
    ratingAvg: p.ratingAvg,
    reviewCount: p.reviewCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export type PublicPlace = ReturnType<typeof toPublicPlace>;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bboxPolygon([w, s, e, n]: ListPlacesQuery['bbox']) {
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

/** Approved places inside a bounding box. Nothing about the caller is recorded. */
export async function listApprovedPlaces(query: ListPlacesQuery): Promise<Page<PublicPlace>> {
  const filter: Record<string, unknown> = {
    approvalStatus: 'approved',
    location: { $geoWithin: { $geometry: bboxPolygon(query.bbox) } },
    ...afterCursor(query.cursor),
  };
  if (query.type) filter.type = query.type;
  if (query.q) filter.name = { $regex: escapeRegex(query.q), $options: 'i' };

  const rows = await PlaceModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<PlaceRow[]>();
  const page = toPage(rows, query.limit);
  return { items: page.items.map(toPublicPlace), nextCursor: page.nextCursor };
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
    { $set: { approvalStatus } },
    { returnDocument: 'after' },
  ).lean<PlaceRow>();
  return row ? toPublicPlace(row) : null;
}
