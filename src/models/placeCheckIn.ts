import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { VEGAN_LEVELS } from './enums.js';

/**
 * Anonymous visit confirmation. `userId` exists only so a member can check in
 * once per place per calendar month and so account deletion can detach the row.
 * Public responses never read this collection: they read the counts on the place.
 */
const placeCheckInSchema = new Schema(
  {
    placeId: { type: Schema.Types.ObjectId, ref: 'Place', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    /** Server-assigned UTC month (`YYYY-MM`) of the check-in. The rate-limit bucket. */
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    veganLevel: { type: String, enum: VEGAN_LEVELS, required: true },
    rating: { type: Number, min: 1, max: 5 },
  },
  { timestamps: true, collection: 'place_checkins' },
);

placeCheckInSchema.index(
  { placeId: 1, userId: 1, month: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } },
);
placeCheckInSchema.index({ userId: 1 }, { sparse: true });

export type PlaceCheckIn = InferSchemaType<typeof placeCheckInSchema>;
export type PlaceCheckInDoc = HydratedDocument<PlaceCheckIn>;
export const PlaceCheckInModel = model('PlaceCheckIn', placeCheckInSchema);
