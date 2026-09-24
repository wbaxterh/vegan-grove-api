import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import {
  APPROVAL_STATUSES,
  HOME_AREAS,
  PLACE_SOURCES,
  PLACE_TYPES,
  VEGAN_LEVELS,
} from './enums.js';
import { pointSchema } from './geo.js';

/**
 * Sanctuaries, restaurants, groceries and the rest of the map. Public and
 * non-personal; `submittedBy` is never exposed and is detached on deletion.
 */
const placeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true },
    type: { type: String, enum: PLACE_TYPES, required: true },
    veganLevel: { type: String, enum: VEGAN_LEVELS, required: true },
    location: { type: pointSchema, required: true },
    address: { type: String, default: '', maxlength: 240 },
    city: { type: String, default: '', maxlength: 80 },
    area: { type: String, enum: HOME_AREAS, default: 'other' },
    website: { type: String },
    hours: { type: String },
    tags: { type: [String], default: [] },
    description: { type: String, default: '', maxlength: 2000 },
    photoKeys: { type: [String], default: [] },
    approvalStatus: { type: String, enum: APPROVAL_STATUSES, required: true, default: 'pending' },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, enum: PLACE_SOURCES, required: true, default: 'user' },
    osmId: { type: String },
    ratingAvg: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'places' },
);

placeSchema.index({ slug: 1 }, { unique: true });
placeSchema.index({ location: '2dsphere' });
placeSchema.index({ approvalStatus: 1, type: 1 });
placeSchema.index({ osmId: 1 }, { unique: true, sparse: true });
placeSchema.index({ submittedBy: 1 }, { sparse: true });

export type Place = InferSchemaType<typeof placeSchema>;
export type PlaceDoc = HydratedDocument<Place>;
export const PlaceModel = model('Place', placeSchema);
