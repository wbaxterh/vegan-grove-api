import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

const quietHoursSchema = new Schema(
  {
    start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    timezone: { type: String, required: true, default: 'America/Los_Angeles' },
  },
  { _id: false },
);

const notificationPreferencesSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    eventReminders: { type: Boolean, default: true },
    friendRequests: { type: Boolean, default: true },
    messages: { type: Boolean, default: true },
    quietHours: { type: quietHoursSchema },
  },
  { timestamps: true, collection: 'notification_preferences' },
);

notificationPreferencesSchema.index({ userId: 1 }, { unique: true });

export type NotificationPreferences = InferSchemaType<typeof notificationPreferencesSchema>;
export type NotificationPreferencesDoc = HydratedDocument<NotificationPreferences>;
export const NotificationPreferencesModel = model(
  'NotificationPreferences',
  notificationPreferencesSchema,
);
