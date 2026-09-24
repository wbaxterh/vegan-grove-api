import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { RSVP_STATUSES } from './enums.js';

/** RSVPs are private: the organizer sees attendees, everyone else sees counts. */
const eventRsvpSchema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: RSVP_STATUSES, required: true, default: 'going' },
  },
  { timestamps: true, collection: 'event_rsvps' },
);

eventRsvpSchema.index({ eventId: 1, userId: 1 }, { unique: true });
eventRsvpSchema.index({ userId: 1 });

export type EventRsvp = InferSchemaType<typeof eventRsvpSchema>;
export type EventRsvpDoc = HydratedDocument<EventRsvp>;
export const EventRsvpModel = model('EventRsvp', eventRsvpSchema);
