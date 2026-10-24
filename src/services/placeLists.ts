import { afterCursor, type Page, toPage } from '../lib/cursor.js';
import { badRequest, notFound } from '../lib/errors.js';
import { type PlaceListDoc, PlaceListModel, PlaceModel, type Types } from '../models/index.js';
import { type PlaceRow, type PublicPlace, toPublicPlace } from './places.js';

const MAX_PLACES = 500;

export interface PlaceListInput {
  name: string;
  placeIds: Types.ObjectId[];
  isPublic: boolean;
}

export interface PlaceListPatch {
  name?: string;
  placeIds?: Types.ObjectId[];
  isPublic?: boolean;
}

export interface PublicPlaceList {
  id: string;
  name: string;
  /**
   * Stored for a later friends-sharing milestone. It does not grant access:
   * every read is filtered to the owner.
   */
  isPublic: boolean;
  placeIds: string[];
  places: PublicPlace[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Place lists are private to their owner. `isPublic` is persisted because the
 * data model has the flag and the docs describe friends sharing as later work.
 * Nothing in this service returns another member's list, public or not.
 */

function dedupe(ids: Types.ObjectId[]): Types.ObjectId[] {
  const seen = new Set<string>();
  const out: Types.ObjectId[] = [];
  for (const id of ids) {
    const hex = id.toHexString();
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(id);
  }
  return out;
}

async function placesById(ids: Types.ObjectId[]): Promise<Map<string, PublicPlace>> {
  if (ids.length === 0) return new Map();
  const rows = await PlaceModel.find({ _id: { $in: ids } }).lean<PlaceRow[]>();
  return new Map(rows.map((row) => [row._id.toHexString(), toPublicPlace(row)]));
}

function orderedPlaces(ids: Types.ObjectId[], byId: Map<string, PublicPlace>): PublicPlace[] {
  return ids.flatMap((id) => {
    const place = byId.get(id.toHexString());
    return place ? [place] : [];
  });
}

async function toList(
  doc: PlaceListDoc,
  byId?: Map<string, PublicPlace>,
): Promise<PublicPlaceList> {
  const places = byId ?? (await placesById(doc.placeIds));
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    isPublic: doc.isPublic,
    placeIds: doc.placeIds.map((id) => id.toHexString()),
    places: orderedPlaces(doc.placeIds, places),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function assertPlacesExist(ids: Types.ObjectId[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await PlaceModel.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) throw notFound('Place not found.');
}

async function requireOwnList(userId: Types.ObjectId, id: Types.ObjectId): Promise<PlaceListDoc> {
  const list = await PlaceListModel.findOne({ _id: id, userId });
  if (!list) throw notFound('List not found.');
  return list;
}

export async function listPlaceLists(
  userId: Types.ObjectId,
  query: { cursor?: string; limit: number },
): Promise<Page<PublicPlaceList>> {
  const rows = await PlaceListModel.find({ userId, ...afterCursor(query.cursor) })
    .sort({ _id: -1 })
    .limit(query.limit + 1);
  const page = toPage(rows, query.limit);
  const byId = await placesById(page.items.flatMap((doc) => doc.placeIds));
  const items = await Promise.all(page.items.map((doc) => toList(doc, byId)));
  return { items, nextCursor: page.nextCursor };
}

export async function getPlaceList(
  userId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<PublicPlaceList> {
  return toList(await requireOwnList(userId, id));
}

export async function createPlaceList(
  userId: Types.ObjectId,
  input: PlaceListInput,
): Promise<PublicPlaceList> {
  const placeIds = dedupe(input.placeIds);
  await assertPlacesExist(placeIds);
  const doc = await PlaceListModel.create({
    userId,
    name: input.name,
    placeIds,
    isPublic: input.isPublic,
  });
  return toList(doc);
}

export async function updatePlaceList(
  userId: Types.ObjectId,
  id: Types.ObjectId,
  input: PlaceListPatch,
): Promise<PublicPlaceList> {
  const list = await requireOwnList(userId, id);
  if (input.name !== undefined) list.name = input.name;
  if (input.isPublic !== undefined) list.isPublic = input.isPublic;
  if (input.placeIds !== undefined) {
    const placeIds = dedupe(input.placeIds);
    await assertPlacesExist(placeIds);
    list.placeIds = placeIds;
    list.markModified('placeIds');
  }
  await list.save();
  return toList(list);
}

export async function deletePlaceList(userId: Types.ObjectId, id: Types.ObjectId): Promise<void> {
  const res = await PlaceListModel.deleteOne({ _id: id, userId });
  if (res.deletedCount !== 1) throw notFound('List not found.');
}

export async function addPlaceToList(
  userId: Types.ObjectId,
  id: Types.ObjectId,
  placeId: Types.ObjectId,
): Promise<PublicPlaceList> {
  await assertPlacesExist([placeId]);
  const list = await requireOwnList(userId, id);
  const hex = placeId.toHexString();
  const already = list.placeIds.some((existing) => existing.toHexString() === hex);
  if (!already) {
    if (list.placeIds.length >= MAX_PLACES) {
      throw badRequest('list_full', 'A list can hold at most 500 places.');
    }
    list.placeIds.push(placeId);
    await list.save();
  }
  return toList(list);
}

export async function removePlaceFromList(
  userId: Types.ObjectId,
  id: Types.ObjectId,
  placeId: Types.ObjectId,
): Promise<PublicPlaceList> {
  const list = await requireOwnList(userId, id);
  const hex = placeId.toHexString();
  const next = list.placeIds.filter((existing) => existing.toHexString() !== hex);
  if (next.length !== list.placeIds.length) {
    list.placeIds = next;
    list.markModified('placeIds');
    await list.save();
  }
  return toList(list);
}
