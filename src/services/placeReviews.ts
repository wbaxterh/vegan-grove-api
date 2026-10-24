import { afterCursor, type Page, toPage } from '../lib/cursor.js';
import { conflict, notFound } from '../lib/errors.js';
import {
  PlaceModel,
  PlaceReviewModel,
  type ReviewStatus,
  type Types,
  UserModel,
} from '../models/index.js';

export interface ReviewInput {
  rating: number;
  content: string;
  visitedMonth?: string;
  showHandle: boolean;
}

/** What anyone may see. No user id, no email. The handle is present only when the author opted in. */
export interface PublicReview {
  id: string;
  placeId: string;
  rating: number;
  content: string;
  visitedMonth: string | null;
  showHandle: boolean;
  handle: string | null;
  createdAt: Date;
  /** Set only when the caller has a session. Never reveals anyone else's identity. */
  mine?: boolean;
}

export interface AdminReview extends Omit<PublicReview, 'mine'> {
  status: ReviewStatus;
}

interface ReviewRow {
  _id: Types.ObjectId;
  placeId: Types.ObjectId;
  userId?: Types.ObjectId | null;
  rating: number;
  content?: string | null;
  visitedMonth?: string | null;
  showHandle?: boolean | null;
  status?: ReviewStatus | null;
  createdAt: Date;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

async function requireApprovedPlace(placeId: Types.ObjectId): Promise<void> {
  const place = await PlaceModel.exists({ _id: placeId, approvalStatus: 'approved' });
  if (!place) throw notFound('Place not found.');
}

async function handlesByUser(rows: ReviewRow[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((row) => (row.showHandle && row.userId ? [row.userId] : []));
  if (ids.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: ids }, deletedAt: null })
    .select('handle')
    .lean<Array<{ _id: Types.ObjectId; handle: string }>>();
  return new Map(users.map((user) => [user._id.toHexString(), user.handle]));
}

function toPublicReview(
  row: ReviewRow,
  handles: Map<string, string>,
  viewerId: Types.ObjectId | null,
): PublicReview {
  const handle =
    row.showHandle && row.userId ? (handles.get(row.userId.toHexString()) ?? null) : null;
  const review: PublicReview = {
    id: row._id.toHexString(),
    placeId: row.placeId.toHexString(),
    rating: row.rating,
    content: row.content ?? '',
    visitedMonth: row.visitedMonth ?? null,
    showHandle: Boolean(handle),
    handle,
    createdAt: row.createdAt,
  };
  if (viewerId) review.mine = Boolean(row.userId?.equals(viewerId));
  return review;
}

function toAdminReview(row: ReviewRow, handles: Map<string, string>): AdminReview {
  const { mine: _mine, ...review } = toPublicReview(row, handles, null);
  return { ...review, status: row.status ?? 'active' };
}

/** Active reviews only. A place that is not approved is indistinguishable from a missing one. */
export async function listReviews(
  placeId: Types.ObjectId,
  query: { cursor?: string; limit: number },
  viewerId: Types.ObjectId | null,
): Promise<Page<PublicReview>> {
  await requireApprovedPlace(placeId);
  const rows = await PlaceReviewModel.find({
    placeId,
    status: 'active',
    ...afterCursor(query.cursor),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<ReviewRow[]>();
  const page = toPage(rows, query.limit);
  const handles = await handlesByUser(page.items);
  return {
    items: page.items.map((row) => toPublicReview(row, handles, viewerId)),
    nextCursor: page.nextCursor,
  };
}

export async function createReview(
  placeId: Types.ObjectId,
  userId: Types.ObjectId,
  input: ReviewInput,
): Promise<PublicReview> {
  await requireApprovedPlace(placeId);
  let created: ReviewRow;
  try {
    const doc = await PlaceReviewModel.create({
      placeId,
      userId,
      rating: input.rating,
      content: input.content,
      visitedMonth: input.visitedMonth,
      showHandle: input.showHandle,
      status: 'active',
    });
    created = doc.toObject() as ReviewRow;
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw conflict('review_exists', 'You already reviewed this place.');
    }
    throw err;
  }
  await recomputePlaceRating(placeId);
  const handles = await handlesByUser([created]);
  return toPublicReview(created, handles, userId);
}

export async function adminListReviews(query: {
  cursor?: string;
  limit: number;
  status?: ReviewStatus;
}): Promise<Page<AdminReview>> {
  const filter: Record<string, unknown> = { ...afterCursor(query.cursor) };
  if (query.status) filter.status = query.status;
  const rows = await PlaceReviewModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<ReviewRow[]>();
  const page = toPage(rows, query.limit);
  const handles = await handlesByUser(page.items);
  return {
    items: page.items.map((row) => toAdminReview(row, handles)),
    nextCursor: page.nextCursor,
  };
}

/**
 * Hide or restore a review. Ratings follow the active set. The author stays hidden.
 * Restoring is refused when that member already has another active review here.
 */
export async function setReviewStatus(
  id: Types.ObjectId,
  status: ReviewStatus,
): Promise<AdminReview | null> {
  const current = await PlaceReviewModel.findById(id).select('placeId userId').lean<ReviewRow>();
  if (!current) return null;
  if (status === 'active' && current.userId) {
    const other = await PlaceReviewModel.exists({
      _id: { $ne: id },
      placeId: current.placeId,
      userId: current.userId,
      status: 'active',
    });
    if (other) {
      throw conflict('review_exists', 'This member already has an active review for this place.');
    }
  }
  let row: ReviewRow | null;
  try {
    row = await PlaceReviewModel.findOneAndUpdate(
      { _id: id },
      { $set: { status } },
      { returnDocument: 'after' },
    ).lean<ReviewRow>();
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw conflict('review_exists', 'This member already has an active review for this place.');
    }
    throw err;
  }
  if (!row) return null;
  await recomputePlaceRating(row.placeId);
  const handles = await handlesByUser([row]);
  return toAdminReview(row, handles);
}

async function recomputePlaceRating(placeId: Types.ObjectId): Promise<void> {
  const [row] = await PlaceReviewModel.aggregate<{ avg: number; n: number }>([
    { $match: { placeId, status: 'active' } },
    { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } },
  ]);
  const reviewCount = row?.n ?? 0;
  const ratingAvg = reviewCount === 0 ? 0 : Math.round((row?.avg ?? 0) * 100) / 100;
  await PlaceModel.updateOne({ _id: placeId }, { $set: { ratingAvg, reviewCount } });
}
