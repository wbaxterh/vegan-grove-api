import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { MESSAGE_TYPES } from './enums.js';

/**
 * DM rows hold ciphertext only (AES-256-GCM via services/crypto/dm.ts).
 * `expiresAt` enforces the 90-day retention default with a TTL index.
 */
const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    keyId: { type: String, required: true },
    type: { type: String, enum: MESSAGE_TYPES, required: true, default: 'text' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'messages' },
);

messageSchema.index({ conversationId: 1, _id: -1 });
messageSchema.index({ senderId: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type Message = InferSchemaType<typeof messageSchema>;
export type MessageDoc = HydratedDocument<Message>;
export const MessageModel = model('Message', messageSchema);
