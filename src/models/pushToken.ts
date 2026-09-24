import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { PUSH_PLATFORMS } from './enums.js';

/** Device push tokens. A token marked dead is purged 30 days later by TTL. */
const pushTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true },
    platform: { type: String, enum: PUSH_PLATFORMS, required: true },
    deadAt: { type: Date },
  },
  { timestamps: true, collection: 'push_tokens' },
);

pushTokenSchema.index({ token: 1 }, { unique: true });
pushTokenSchema.index({ userId: 1, platform: 1 });
pushTokenSchema.index({ deadAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export type PushToken = InferSchemaType<typeof pushTokenSchema>;
export type PushTokenDoc = HydratedDocument<PushToken>;
export const PushTokenModel = model('PushToken', pushTokenSchema);
