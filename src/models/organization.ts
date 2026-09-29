import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { HOME_AREAS, ORGANIZATION_TYPES } from './enums.js';
import { provenanceFields, provenanceIndex } from './provenance.js';

/** Orgs, sanctuaries and businesses that host events. Guests, not members. */
const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true },
    type: { type: String, enum: ORGANIZATION_TYPES, required: true },
    description: { type: String, default: '', maxlength: 4000 },
    website: { type: String },
    socials: { type: Map, of: String, default: {} },
    area: { type: String, enum: HOME_AREAS },
    verified: { type: Boolean, default: false },
    adminUserIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    ...provenanceFields('curated'),
  },
  { timestamps: true, collection: 'organizations' },
);

organizationSchema.index({ slug: 1 }, { unique: true });
organizationSchema.index({ verified: -1, name: 1, _id: 1 });
organizationSchema.index({ adminUserIds: 1 });
provenanceIndex(organizationSchema);

export type Organization = InferSchemaType<typeof organizationSchema>;
export type OrganizationDoc = HydratedDocument<Organization>;
export const OrganizationModel = model('Organization', organizationSchema);
