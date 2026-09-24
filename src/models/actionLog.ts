import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { ACTION_TYPES } from './enums.js';

/** A member's private impact journal. Never aggregated without opt-in. */
const actionLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ACTION_TYPES, required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    hours: { type: Number, min: 0, max: 24 },
    note: { type: String, maxlength: 500 },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'action_log' },
);

actionLogSchema.index({ userId: 1, occurredAt: -1 });

export type ActionLog = InferSchemaType<typeof actionLogSchema>;
export type ActionLogDoc = HydratedDocument<ActionLog>;
export const ActionLogModel = model('ActionLog', actionLogSchema);
