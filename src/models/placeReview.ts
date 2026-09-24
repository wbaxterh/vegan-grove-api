import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { REVIEW_STATUSES } from './enums.js';

/** Pseudonymous reviews; the handle shows only when the author opts in per review. */
const placeReviewSchema = new Schema(
  {
    placeId: { type: Schema.Types.ObjectId, ref: 'Place', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, required: true, min: 1, max: 5 },
    content: { type: String, default: '', maxlength: 1000 },
    visitedMonth: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    showHandle: { type: Boolean, default: false },
    status: { type: String, enum: REVIEW_STATUSES, default: 'active' },
  },
  { timestamps: true, collection: 'place_reviews' },
);

placeReviewSchema.index({ placeId: 1, status: 1, _id: -1 });
placeReviewSchema.index({ userId: 1 }, { sparse: true });

export type PlaceReview = InferSchemaType<typeof placeReviewSchema>;
export type PlaceReviewDoc = HydratedDocument<PlaceReview>;
export const PlaceReviewModel = model('PlaceReview', placeReviewSchema);
