import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { GUIDE_CATEGORIES, PUBLISH_STATUSES } from './enums.js';

/** Editorial guides: outreach scripts, know your rights, vegan 101. Markdown body. */
const guideSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true },
    category: { type: String, enum: GUIDE_CATEGORIES, required: true },
    body: { type: String, required: true },
    status: { type: String, enum: PUBLISH_STATUSES, required: true, default: 'draft' },
  },
  { timestamps: true, collection: 'guides' },
);

guideSchema.index({ slug: 1 }, { unique: true });
guideSchema.index({ status: 1, category: 1, _id: -1 });

export type Guide = InferSchemaType<typeof guideSchema>;
export type GuideDoc = HydratedDocument<Guide>;
export const GuideModel = model('Guide', guideSchema);
