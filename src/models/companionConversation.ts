import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { COMPANION_ROLES } from './enums.js';

const companionMessageSchema = new Schema(
  {
    role: { type: String, enum: COMPANION_ROLES, required: true },
    content: { type: String, required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

/**
 * Ivy chats are ephemeral: unpinned conversations carry `expiresAt` and the TTL
 * index removes them 24 h after the last turn. Pinning unsets `expiresAt`, and
 * Mongo's TTL monitor skips documents without the field.
 */
const companionConversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    messages: { type: [companionMessageSchema], default: [] },
    pinned: { type: Boolean, default: false },
    expiresAt: { type: Date },
  },
  { timestamps: true, collection: 'companion_conversations' },
);

companionConversationSchema.index({ userId: 1, _id: -1 });
companionConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const COMPANION_UNPINNED_TTL_MS = 24 * 60 * 60 * 1000;

export type CompanionConversation = InferSchemaType<typeof companionConversationSchema>;
export type CompanionConversationDoc = HydratedDocument<CompanionConversation>;
export const CompanionConversationModel = model(
  'CompanionConversation',
  companionConversationSchema,
);
