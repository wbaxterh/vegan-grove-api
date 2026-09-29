import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { APPROVAL_STATUSES, HOME_AREAS, PLACE_TYPES, VEGAN_LEVELS } from './enums.js';
import { pointSchema } from './geo.js';
import { provenanceFields, provenanceIndex } from './provenance.js';

/**
 * Sanctuaries, restaurants, groceries, gardens and the rest of the map. Public
 * and non-personal; `submittedBy` is never exposed and is detached on deletion.
 * `phone` is the business line from the source, never a member's.
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
    postcode: { type: String, maxlength: 16 },
    area: { type: String, enum: HOME_AREAS, default: 'other' },
    website: { type: String },
    phone: { type: String, maxlength: 40 },
    hours: { type: String },
    chain: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    description: { type: String, default: '', maxlength: 2000 },
    photoKeys: { type: [String], default: [] },
    approvalStatus: { type: String, enum: APPROVAL_STATUSES, required: true, default: 'pending' },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    ...provenanceFields('user'),
    /** Kept for compatibility with the first import; equals `sourceId` on OSM rows. */
    osmId: { type: String },
    ratingAvg: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'places' },
);

placeSchema.index({ slug: 1 }, { unique: true });
placeSchema.index({ location: '2dsphere' });
placeSchema.index({ approvalStatus: 1, type: 1 });
// The public ranking: fully vegan first, independents before chains, then by reviews and name.
placeSchema.index({
  approvalStatus: 1,
  veganLevel: 1,
  chain: 1,
  reviewCount: -1,
  name: 1,
  _id: 1,
});
placeSchema.index({ osmId: 1 }, { unique: true, sparse: true });
placeSchema.index({ submittedBy: 1 }, { sparse: true });
provenanceIndex(placeSchema);

export type Place = InferSchemaType<typeof placeSchema>;
export type PlaceDoc = HydratedDocument<Place>;
export const PlaceModel = model('Place', placeSchema);
