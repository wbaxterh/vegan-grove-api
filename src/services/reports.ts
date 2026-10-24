import { conflict, forbidden, notFound } from '../lib/errors.js';
import {
  PlaceModel,
  PlaceReviewModel,
  ReportModel,
  type ReportTarget,
  type Types,
} from '../models/index.js';

export interface FiledReport {
  id: string;
  targetType: ReportTarget;
  targetId: string;
  reason: string;
  status: 'open';
  createdAt: Date;
}

/**
 * The reporter is the session user. The response never includes `reportedBy`.
 * Reviews and places are checked so a report points at a real public target.
 * Other target types are stored without a lookup: probing posts, messages, or
 * accounts from this route would reveal private rows.
 */
export async function fileReport(
  reportedBy: Types.ObjectId,
  input: { targetType: ReportTarget; targetId: Types.ObjectId; reason: string },
): Promise<FiledReport> {
  await assertPublicTarget(input.targetType, input.targetId, reportedBy);

  const duplicate = await ReportModel.exists({
    reportedBy,
    targetType: input.targetType,
    targetId: input.targetId,
    status: { $in: ['open', 'reviewing'] },
  });
  if (duplicate) throw conflict('already_reported', 'You already reported this.');

  const doc = await ReportModel.create({
    targetType: input.targetType,
    targetId: input.targetId,
    reportedBy,
    reason: input.reason,
    status: 'open',
  });

  return {
    id: doc._id.toHexString(),
    targetType: input.targetType,
    targetId: input.targetId.toHexString(),
    reason: doc.reason,
    status: 'open',
    createdAt: doc.createdAt,
  };
}

async function assertPublicTarget(
  targetType: ReportTarget,
  targetId: Types.ObjectId,
  reportedBy: Types.ObjectId,
): Promise<void> {
  if (targetType === 'review') {
    const review = await PlaceReviewModel.findOne({ _id: targetId, status: 'active' })
      .select('userId')
      .lean<{ userId?: Types.ObjectId | null }>();
    if (!review) throw notFound('Review not found.');
    if (review.userId?.equals(reportedBy)) {
      throw forbidden('You cannot report your own review.');
    }
    return;
  }
  if (targetType === 'place') {
    const place = await PlaceModel.exists({ _id: targetId });
    if (!place) throw notFound('Place not found.');
  }
}
