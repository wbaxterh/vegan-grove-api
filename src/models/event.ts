import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { EVENT_STATUSES, EVENT_TYPES, EVENT_VISIBILITIES, HOST_TYPES } from './enums.js';
import { pointSchema } from './geo.js';

/**
 * Protests, vigils, outreach, potlucks, sanctuary days. Public listing;
 * `detailsAfterRsvp` hides the exact address until someone commits.
 */
const eventSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    slug: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    location: { type: pointSchema, required: true },
    placeId: { type: Schema.Types.ObjectId, ref: 'Place' },
    venueName: { type: String, default: '', maxlength: 120 },
    address: { type: String, default: '', maxlength: 240 },
    detailsAfterRsvp: { type: Boolean, default: false },
    hostType: { type: String, enum: HOST_TYPES, required: true },
    hostId: { type: Schema.Types.ObjectId, required: true, refPath: 'hostModel' },
    hostModel: { type: String, enum: ['Grove', 'Organization'], required: true },
    description: { type: String, default: '', maxlength: 4000 },
    coverKey: { type: String },
    visibility: { type: String, enum: EVENT_VISIBILITIES, default: 'public' },
    rsvpCount: { type: Number, default: 0 },
    status: { type: String, enum: EVENT_STATUSES, default: 'draft' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'events' },
);

eventSchema.index({ slug: 1 }, { unique: true });
eventSchema.index({ location: '2dsphere' });
eventSchema.index({ status: 1, visibility: 1, startsAt: 1 });
eventSchema.index({ hostType: 1, hostId: 1 });

export type Event = InferSchemaType<typeof eventSchema>;
export type EventDoc = HydratedDocument<Event>;
export const EventModel = model('Event', eventSchema);
