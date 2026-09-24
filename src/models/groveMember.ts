import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { GROVE_ROLES } from './enums.js';

/** Who belongs to which grove. Never listed to other members. */
const groveMemberSchema = new Schema(
  {
    groveId: { type: Schema.Types.ObjectId, ref: 'Grove', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: GROVE_ROLES, default: 'member' },
  },
  { timestamps: true, collection: 'grove_members' },
);

groveMemberSchema.index({ groveId: 1, userId: 1 }, { unique: true });
groveMemberSchema.index({ userId: 1 });

export type GroveMember = InferSchemaType<typeof groveMemberSchema>;
export type GroveMemberDoc = HydratedDocument<GroveMember>;
export const GroveMemberModel = model('GroveMember', groveMemberSchema);
