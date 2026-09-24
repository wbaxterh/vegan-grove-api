import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** A member's saved places. Private unless the owner flips `isPublic`. */
const placeListSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    placeIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Place' }], default: [] },
    isPublic: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'place_lists' },
);

placeListSchema.index({ userId: 1, _id: -1 });

export type PlaceList = InferSchemaType<typeof placeListSchema>;
export type PlaceListDoc = HydratedDocument<PlaceList>;
export const PlaceListModel = model('PlaceList', placeListSchema);
