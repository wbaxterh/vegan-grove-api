import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { REACTION_TYPES } from './enums.js';

/** Love reactions only. No dunking. */
const reactionSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: REACTION_TYPES, required: true, default: 'love' },
  },
  { timestamps: true, collection: 'reactions' },
);

reactionSchema.index({ postId: 1, userId: 1 }, { unique: true });
reactionSchema.index({ userId: 1 });

export type Reaction = InferSchemaType<typeof reactionSchema>;
export type ReactionDoc = HydratedDocument<Reaction>;
export const ReactionModel = model('Reaction', reactionSchema);
