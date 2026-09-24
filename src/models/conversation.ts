import { type HydratedDocument, type InferSchemaType, model, Schema, type Types } from 'mongoose';

/**
 * A DM thread. `participantIds` is kept sorted and mirrored into `pairKey`
 * (`"<idA>:<idB>"`) because a unique index on the array itself would be
 * per-element, forbidding one member from having two conversations.
 */
const conversationSchema = new Schema(
  {
    participantIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (v: unknown[]) => v.length >= 2,
        message: 'a conversation needs at least two participants',
      },
    },
    pairKey: { type: String, required: true },
    lastMessageAt: { type: Date },
    unread: { type: Map, of: Number, default: {} },
  },
  { timestamps: true, collection: 'conversations' },
);

conversationSchema.index({ pairKey: 1 }, { unique: true });
conversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

export function conversationPairKey(ids: Types.ObjectId[]): string {
  return ids
    .map((id) => id.toHexString())
    .sort()
    .join(':');
}

export type Conversation = InferSchemaType<typeof conversationSchema>;
export type ConversationDoc = HydratedDocument<Conversation>;
export const ConversationModel = model('Conversation', conversationSchema);
