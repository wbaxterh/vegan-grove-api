import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { AUTH_PROVIDERS, HOME_AREAS, USER_ROLES } from './enums.js';

export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;

/**
 * An activist. This is the whole record: no name, phone, birthdate or GPS.
 * `email` is optional only for accounts created from an Apple/Google token
 * that carried no email; it is unique wherever it is present.
 */
const providerSchema = new Schema(
  {
    provider: { type: String, enum: AUTH_PROVIDERS, required: true },
    subject: { type: String, required: true },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: { type: String, lowercase: true, trim: true },
    emailVerifiedAt: { type: Date },
    passwordHash: { type: String },
    handle: { type: String, required: true, lowercase: true, trim: true, match: HANDLE_PATTERN },
    avatarKey: { type: String },
    homeArea: { type: String, enum: HOME_AREAS, default: 'other' },
    discoverable: { type: Boolean, default: false },
    publicPostsEnabled: { type: Boolean, default: false },
    role: { type: String, enum: USER_ROLES, default: 'member' },
    providers: { type: [providerSchema], default: [] },
    interests: { type: [String], default: [] },
    deletedAt: { type: Date },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index({ handle: 1 }, { unique: true });
userSchema.index(
  { 'providers.provider': 1, 'providers.subject': 1 },
  { unique: true, sparse: true },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;
export const UserModel = model('User', userSchema);
