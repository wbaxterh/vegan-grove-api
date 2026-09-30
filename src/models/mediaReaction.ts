import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { MEDIA_REACTION_TYPES } from './enums.js';

/**
 * "This moved me" and "I took action": one row per (title, member, type).
 * Counts are public on the title; who reacted never leaves the server.
 */
const mediaReactionSchema = new Schema(
  {
    mediaId: { type: Schema.Types.ObjectId, ref: 'MediaItem', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: MEDIA_REACTION_TYPES, required: true },
  },
  { timestamps: true, collection: 'media_reactions' },
);

mediaReactionSchema.index({ mediaId: 1, userId: 1, type: 1 }, { unique: true });
mediaReactionSchema.index({ userId: 1 });

export type MediaReaction = InferSchemaType<typeof mediaReactionSchema>;
export type MediaReactionDoc = HydratedDocument<MediaReaction>;
export const MediaReactionModel = model('MediaReaction', mediaReactionSchema);
