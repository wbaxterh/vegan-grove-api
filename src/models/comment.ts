import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { COMMENT_STATUSES } from './enums.js';

const commentSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Comment' },
    content: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: COMMENT_STATUSES, required: true, default: 'active' },
  },
  { timestamps: true, collection: 'comments' },
);

commentSchema.index({ postId: 1, _id: -1 });
commentSchema.index({ userId: 1 });

export type Comment = InferSchemaType<typeof commentSchema>;
export type CommentDoc = HydratedDocument<Comment>;
export const CommentModel = model('Comment', commentSchema);
