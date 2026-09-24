import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** Single-use, 15-minute login links. Only the token hash is stored. */
const magicLinkSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true, collection: 'magic_links' },
);

magicLinkSchema.index({ tokenHash: 1 }, { unique: true });
magicLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type MagicLink = InferSchemaType<typeof magicLinkSchema>;
export type MagicLinkDoc = HydratedDocument<MagicLink>;
export const MagicLinkModel = model('MagicLink', magicLinkSchema);
