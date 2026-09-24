import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES } from './enums.js';

/**
 * Queue for the reminder worker. `idempotencyKey` (e.g. sha1 of
 * `userId:eventId:scheduledFor`) makes re-planning safe: a duplicate insert
 * fails on the unique index instead of double-sending.
 */
const scheduledNotificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: NOTIFICATION_STATUSES, required: true, default: 'pending' },
    idempotencyKey: { type: String, required: true },
    attemptCount: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
  },
  { timestamps: true, collection: 'scheduled_notifications' },
);

scheduledNotificationSchema.index({ idempotencyKey: 1 }, { unique: true });
scheduledNotificationSchema.index({ status: 1, scheduledFor: 1 });
scheduledNotificationSchema.index({ userId: 1 });

export type ScheduledNotification = InferSchemaType<typeof scheduledNotificationSchema>;
export type ScheduledNotificationDoc = HydratedDocument<ScheduledNotification>;
export const ScheduledNotificationModel = model(
  'ScheduledNotification',
  scheduledNotificationSchema,
);
