import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { ORGANIZATION_TYPES } from './enums.js';

/** Orgs, sanctuaries and businesses that host events. Guests, not members. */
const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true },
    type: { type: String, enum: ORGANIZATION_TYPES, required: true },
    description: { type: String, default: '', maxlength: 4000 },
    website: { type: String },
    socials: { type: Map, of: String, default: {} },
    verified: { type: Boolean, default: false },
    adminUserIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
  },
  { timestamps: true, collection: 'organizations' },
);

organizationSchema.index({ slug: 1 }, { unique: true });
organizationSchema.index({ adminUserIds: 1 });

export type Organization = InferSchemaType<typeof organizationSchema>;
export type OrganizationDoc = HydratedDocument<Organization>;
export const OrganizationModel = model('Organization', organizationSchema);
