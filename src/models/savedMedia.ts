import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** The watchlist: a saved list, never a history. Private to the member (spec section 3). */
const savedMediaSchema = new Schema(
  {
    mediaId: { type: Schema.Types.ObjectId, ref: 'MediaItem', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'saved_media' },
);

savedMediaSchema.index({ mediaId: 1, userId: 1 }, { unique: true });
savedMediaSchema.index({ userId: 1, _id: -1 });

export type SavedMedia = InferSchemaType<typeof savedMediaSchema>;
export type SavedMediaDoc = HydratedDocument<SavedMedia>;
export const SavedMediaModel = model('SavedMedia', savedMediaSchema);
