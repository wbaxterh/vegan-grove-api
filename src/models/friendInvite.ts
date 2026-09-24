import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** Short-lived invite codes: the only way to connect, since there is no search. */
const friendInviteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    code: { type: String, required: true, minlength: 8, maxlength: 8 },
    expiresAt: { type: Date, required: true },
    usesLeft: { type: Number, required: true, default: 1, min: 0 },
  },
  { timestamps: true, collection: 'friend_invites' },
);

friendInviteSchema.index({ code: 1 }, { unique: true });
friendInviteSchema.index({ userId: 1 });
friendInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type FriendInvite = InferSchemaType<typeof friendInviteSchema>;
export type FriendInviteDoc = HydratedDocument<FriendInvite>;
export const FriendInviteModel = model('FriendInvite', friendInviteSchema);
