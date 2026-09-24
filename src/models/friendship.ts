import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { FRIENDSHIP_STATUSES } from './enums.js';

/**
 * Mutual, private connections. `userA` < `userB` by ObjectId order so the pair
 * has exactly one row regardless of who asked.
 */
const friendshipSchema = new Schema(
  {
    userA: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userB: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: FRIENDSHIP_STATUSES, required: true, default: 'pending' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'friendships' },
);

friendshipSchema.index({ userA: 1, userB: 1 }, { unique: true });
friendshipSchema.index({ userB: 1, status: 1 });

export type Friendship = InferSchemaType<typeof friendshipSchema>;
export type FriendshipDoc = HydratedDocument<Friendship>;
export const FriendshipModel = model('Friendship', friendshipSchema);
