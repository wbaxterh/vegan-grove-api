import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { MEDIA_TYPES, POST_STATUSES, POST_VISIBILITIES } from './enums.js';

/** Photo and video posts. Default visibility is friends; public is a per-user opt-in. */
const postSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mediaType: { type: String, enum: MEDIA_TYPES, required: true },
    imageKeys: { type: [String], default: [] },
    bunnyVideoId: { type: String },
    caption: { type: String, default: '', maxlength: 2200 },
    visibility: { type: String, enum: POST_VISIBILITIES, required: true, default: 'friends' },
    groveId: { type: Schema.Types.ObjectId, ref: 'Grove' },
    placeId: { type: Schema.Types.ObjectId, ref: 'Place' },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    stats: {
      love: { type: Number, default: 0 },
      comment: { type: Number, default: 0 },
      save: { type: Number, default: 0 },
    },
    status: { type: String, enum: POST_STATUSES, required: true, default: 'processing' },
  },
  { timestamps: true, collection: 'posts' },
);

postSchema.index({ userId: 1, _id: -1 });
postSchema.index({ visibility: 1, status: 1, _id: -1 });
postSchema.index({ groveId: 1, status: 1, _id: -1 }, { sparse: true });

export type Post = InferSchemaType<typeof postSchema>;
export type PostDoc = HydratedDocument<Post>;
export const PostModel = model('Post', postSchema);
