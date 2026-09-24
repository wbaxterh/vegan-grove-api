import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { REPORT_STATUSES, REPORT_TARGETS } from './enums.js';

/** Moderation reports. `reportedBy` is detached when the reporter deletes their account. */
const reportSchema = new Schema(
  {
    targetType: { type: String, enum: REPORT_TARGETS, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    reportedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: REPORT_STATUSES, required: true, default: 'open' },
  },
  { timestamps: true, collection: 'reports' },
);

reportSchema.index({ status: 1, _id: -1 });
reportSchema.index({ targetType: 1, targetId: 1 });

export type Report = InferSchemaType<typeof reportSchema>;
export type ReportDoc = HydratedDocument<Report>;
export const ReportModel = model('Report', reportSchema);
