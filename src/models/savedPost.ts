import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

const savedPostSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'saved_posts' },
);

savedPostSchema.index({ postId: 1, userId: 1 }, { unique: true });
savedPostSchema.index({ userId: 1, _id: -1 });

export type SavedPost = InferSchemaType<typeof savedPostSchema>;
export type SavedPostDoc = HydratedDocument<SavedPost>;
export const SavedPostModel = model('SavedPost', savedPostSchema);
