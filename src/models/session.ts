import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { CLIENTS } from './enums.js';

/**
 * Opaque session tokens. Only the SHA-256 of the token is stored, so a database
 * read never yields a usable credential. `expiresAt` slides on use and the TTL
 * index removes expired rows.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    client: { type: String, enum: CLIENTS, required: true },
  },
  { timestamps: true, collection: 'sessions' },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type Session = InferSchemaType<typeof sessionSchema>;
export type SessionDoc = HydratedDocument<Session>;
export const SessionModel = model('Session', sessionSchema);
