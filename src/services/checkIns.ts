import { conflict, notFound } from '../lib/errors.js';
import { PlaceCheckInModel, PlaceModel, type Types, type VeganLevel } from '../models/index.js';

/** A check-in agrees with the place when it is this recent. From the places verification spec. */
export const VERIFIED_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

export type PlaceVerification = 'verified' | 'unverified';

export interface CheckInSummary {
  checkInCount: number;
  latestCheckInMonth: string | null;
  verification: PlaceVerification;
}

export interface CheckInInput {
  veganLevel: VeganLevel;
  rating?: number;
}

interface PlaceCheckInFields {
  checkInCount?: number | null;
  latestCheckInMonth?: string | null;
  lastAgreeingCheckInAt?: Date | null;
}

/** UTC `YYYY-MM`. The client does not choose it, so a member cannot backfill a count. */
export function currentUtcMonth(now = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

export function toCheckInSummary(place: PlaceCheckInFields, now = Date.now()): CheckInSummary {
  return {
    checkInCount: place.checkInCount ?? 0,
    latestCheckInMonth: place.latestCheckInMonth ?? null,
    verification: isRecentlyVerified(place.lastAgreeingCheckInAt, now) ? 'verified' : 'unverified',
  };
}

function isRecentlyVerified(at: Date | null | undefined, now: number): boolean {
  if (!at) return false;
  const then = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(then) && now >= then && now - then <= VERIFIED_WINDOW_MS;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

async function requireApprovedPlace(placeId: Types.ObjectId) {
  const place = await PlaceModel.findOne({ _id: placeId, approvalStatus: 'approved' })
    .select('_id veganLevel checkInCount latestCheckInMonth lastAgreeingCheckInAt')
    .lean<PlaceCheckInFields & { _id: Types.ObjectId; veganLevel: VeganLevel }>();
  if (!place) throw notFound('Place not found.');
  return place;
}

/** Counts and the latest month only. This never loads check-in rows. */
export async function getCheckInSummary(placeId: Types.ObjectId): Promise<CheckInSummary> {
  const place = await requireApprovedPlace(placeId);
  return toCheckInSummary(place);
}

/**
 * One check-in per member per place per UTC month. The stored row keeps
 * `userId` for that limit and for deletion; the response is the place aggregate.
 */
export async function createCheckIn(
  placeId: Types.ObjectId,
  userId: Types.ObjectId,
  input: CheckInInput,
): Promise<CheckInSummary> {
  const place = await requireApprovedPlace(placeId);
  const month = currentUtcMonth();
  try {
    await PlaceCheckInModel.create({
      placeId,
      userId,
      month,
      veganLevel: input.veganLevel,
      ...(input.rating !== undefined ? { rating: input.rating } : {}),
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw conflict('already_checked_in', 'You already checked in at this place for this month.');
    }
    throw err;
  }

  const agrees = input.veganLevel === place.veganLevel;
  const updated = await PlaceModel.findOneAndUpdate(
    { _id: placeId },
    {
      $inc: { checkInCount: 1 },
      $max: {
        latestCheckInMonth: month,
        ...(agrees ? { lastAgreeingCheckInAt: new Date() } : {}),
      },
    },
    { returnDocument: 'after' },
  )
    .select('checkInCount latestCheckInMonth lastAgreeingCheckInAt')
    .lean<PlaceCheckInFields>();

  return toCheckInSummary(updated ?? { checkInCount: (place.checkInCount ?? 0) + 1 });
}
