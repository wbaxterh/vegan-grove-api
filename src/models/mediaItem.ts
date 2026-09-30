import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { MEDIA_ACTION_TYPES, MEDIA_KINDS, PUBLISH_STATUSES, WATCH_ACCESS } from './enums.js';
import { provenanceFields, provenanceIndex } from './provenance.js';

const watchLinkSchema = new Schema(
  {
    provider: { type: String, required: true, maxlength: 60 },
    url: { type: String, required: true },
    access: { type: String, enum: WATCH_ACCESS, default: 'unknown' },
  },
  { _id: false },
);

/** A way to act after watching: petition, donation, pledge, volunteering, a guide. */
const mediaActionSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true },
    type: { type: String, enum: MEDIA_ACTION_TYPES, required: true },
    org: { type: String, trim: true, maxlength: 120 },
  },
  { _id: false },
);

/** Public counters. Who saved or reacted is in the private collections, never here. */
const mediaStatsSchema = new Schema(
  {
    saves: { type: Number, default: 0, min: 0 },
    moved: { type: Number, default: 0, min: 0 },
    acted: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/** Catalogue ids so ingest scripts can enrich the same row from several sources. */
const externalIdsSchema = new Schema(
  {
    tmdb: { type: String, maxlength: 20 },
    wikidata: { type: String, maxlength: 20 },
    imdb: { type: String, maxlength: 20 },
  },
  { _id: false },
);

/** Documentaries, films and talks. Trailers embed via youtube-nocookie.com, click to load. */
const mediaItemSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true },
    kind: { type: String, enum: MEDIA_KINDS, required: true },
    year: { type: Number, min: 1900, max: 2100 },
    synopsis: { type: String, default: '', maxlength: 4000 },
    tagline: { type: String, maxlength: 300 },
    posterKey: { type: String },
    backdropKey: { type: String },
    // Library metadata (TMDB, or hand-entered): what a detail page shows above the fold.
    runtimeMinutes: { type: Number, min: 1, max: 1000 },
    releaseDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    directors: { type: [String], default: [] },
    featuring: { type: [String], default: [] },
    genres: { type: [String], default: [] },
    rating: { type: Number, min: 0, max: 10 },
    ratingCount: { type: Number, min: 0 },
    contentRating: { type: String, maxlength: 12 },
    originalLanguage: { type: String, maxlength: 8 },
    watchLinks: { type: [watchLinkSchema], default: [] },
    trailerYoutubeId: { type: String, match: /^[A-Za-z0-9_-]{6,20}$/ },
    officialSite: { type: String },
    tags: { type: [String], default: [] },
    contentWarnings: { type: [String], default: [] },
    actions: { type: [mediaActionSchema], default: [] },
    stats: { type: mediaStatsSchema, default: () => ({}) },
    externalIds: { type: externalIdsSchema },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: PUBLISH_STATUSES, required: true, default: 'draft' },
    ...provenanceFields('curated'),
  },
  { timestamps: true, collection: 'media_items' },
);

mediaItemSchema.index({ slug: 1 }, { unique: true });
mediaItemSchema.index({ status: 1, kind: 1, _id: -1 });
mediaItemSchema.index({ status: 1, tags: 1 });
mediaItemSchema.index({ status: 1, genres: 1 });
mediaItemSchema.index({ status: 1, featured: -1, _id: -1 });
mediaItemSchema.index({ status: 1, year: -1, _id: -1 });
mediaItemSchema.index({ status: 1, 'watchLinks.access': 1 });
mediaItemSchema.index({ status: 1, featured: -1, _id: -1 });
provenanceIndex(mediaItemSchema);

export type MediaItem = InferSchemaType<typeof mediaItemSchema>;
export type MediaItemDoc = HydratedDocument<MediaItem>;
export const MediaItemModel = model('MediaItem', mediaItemSchema);
