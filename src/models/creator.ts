import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { CREATOR_KINDS, CREATOR_STATUSES } from './enums.js';
import { provenanceFields, provenanceIndex } from './provenance.js';

const veganSourceSchema = new Schema(
  {
    url: { type: String, required: true, maxlength: 500 },
    label: { type: String, required: true, trim: true, maxlength: 280 },
  },
  { _id: false },
);

const socialsSchema = new Schema(
  {
    youtube: { type: String, maxlength: 200 },
    instagram: { type: String, maxlength: 200 },
    tiktok: { type: String, maxlength: 200 },
    x: { type: String, maxlength: 200 },
    bluesky: { type: String, maxlength: 200 },
    mastodon: { type: String, maxlength: 200 },
  },
  { _id: false },
);

const externalIdsSchema = new Schema(
  {
    wikidata: { type: String, maxlength: 20 },
  },
  { _id: false },
);

const creatorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true },
    alsoKnownAs: { type: [String], default: [] },
    kind: { type: String, enum: CREATOR_KINDS, required: true, default: 'person' },
    members: { type: [String], default: [] },
    bio: { type: String, default: '', maxlength: 280 },
    topics: { type: [String], default: [] },
    country: { type: String, maxlength: 2 },
    languages: { type: [String], default: [] },
    website: { type: String, maxlength: 500 },
    podcast: { type: String, maxlength: 500 },
    socials: { type: socialsSchema },
    externalIds: { type: externalIdsSchema },
    veganSource: { type: veganSourceSchema },
    relatedGuideIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Guide' },
    relatedMediaIds: { type: [Schema.Types.ObjectId], default: [], ref: 'MediaItem' },
    status: { type: String, enum: CREATOR_STATUSES, required: true, default: 'draft' },
    reviewedAt: { type: Date },
    ...provenanceFields('curated'),
  },
  { timestamps: true, collection: 'creators' },
);

creatorSchema.index({ slug: 1 }, { unique: true });
creatorSchema.index({ status: 1, name: 1 });
creatorSchema.index({ status: 1, topics: 1 });
creatorSchema.index({ status: 1, languages: 1 });
creatorSchema.index(
  { 'externalIds.wikidata': 1 },
  {
    unique: true,
    partialFilterExpression: { 'externalIds.wikidata': { $type: 'string' } },
  },
);
provenanceIndex(creatorSchema);

export type Creator = InferSchemaType<typeof creatorSchema>;
export type CreatorDoc = HydratedDocument<Creator>;
export const CreatorModel = model('Creator', creatorSchema);
