import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { GUIDE_CATEGORIES, PUBLISH_STATUSES } from './enums.js';
import { provenanceFields, provenanceIndex } from './provenance.js';

/** Where a guide's claims come from. Guides are drafted from cited sources, never scraped. */
const guideSourceSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 200 },
    url: { type: String, required: true, maxlength: 500 },
    license: { type: String, maxlength: 100 },
  },
  { _id: false },
);

/** Editorial guides: outreach scripts, know your rights, vegan 101. Markdown body. */
const guideSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true },
    category: { type: String, enum: GUIDE_CATEGORIES, required: true },
    summary: { type: String, default: '', maxlength: 500 },
    body: { type: String, required: true },
    sources: { type: [guideSourceSchema], default: [] },
    status: { type: String, enum: PUBLISH_STATUSES, required: true, default: 'draft' },
    ...provenanceFields('curated'),
  },
  { timestamps: true, collection: 'guides' },
);

guideSchema.index({ slug: 1 }, { unique: true });
guideSchema.index({ status: 1, category: 1, _id: -1 });
provenanceIndex(guideSchema);

export type Guide = InferSchemaType<typeof guideSchema>;
export type GuideDoc = HydratedDocument<Guide>;
export const GuideModel = model('Guide', guideSchema);
