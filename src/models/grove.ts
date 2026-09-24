import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { HOME_AREAS } from './enums.js';

/** Local chapters. Membership is private; only the count is public. */
const groveSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true },
    area: { type: String, enum: HOME_AREAS, required: true },
    description: { type: String, default: '', maxlength: 2000 },
    memberCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'groves' },
);

groveSchema.index({ slug: 1 }, { unique: true });
groveSchema.index({ area: 1 });

export type Grove = InferSchemaType<typeof groveSchema>;
export type GroveDoc = HydratedDocument<Grove>;
export const GroveModel = model('Grove', groveSchema);
