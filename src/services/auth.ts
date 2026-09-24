import { randomBytes } from 'node:crypto';
import argon2, { type HashOptions } from 'argon2';
import { AppError, conflict, unauthorized } from '../lib/errors.js';
import {
  ActionLogModel,
  CommentModel,
  CompanionConversationModel,
  ConversationModel,
  EventModel,
  EventRsvpModel,
  FriendInviteModel,
  FriendshipModel,
  GroveMemberModel,
  MessageModel,
  NotificationPreferencesModel,
  OrganizationModel,
  PlaceListModel,
  PlaceModel,
  PlaceReviewModel,
  PostModel,
  PushTokenModel,
  ReactionModel,
  ReportModel,
  SavedPostModel,
  ScheduledNotificationModel,
  SessionModel,
  type Types,
  type UserDoc,
  UserModel,
} from '../models/index.js';

/** Handles that would impersonate the platform or collide with routes. */
export const RESERVED_HANDLES = new Set([
  'admin',
  'administrator',
  'api',
  'ivy',
  'me',
  'mod',
  'moderator',
  'null',
  'root',
  'support',
  'system',
  'undefined',
  'vegangrove',
  'vegan_grove',
]);

/** OWASP's 2024 minimum for argon2id: 19 MiB, 2 iterations, 1 lane. */
const ARGON2_OPTIONS: HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Lowercase and trim. Nothing more: dot-stripping would merge distinct accounts. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}

export async function isHandleAvailable(
  handle: string,
  excludeUserId?: Types.ObjectId,
): Promise<boolean> {
  const normalized = normalizeHandle(handle);
  if (RESERVED_HANDLES.has(normalized)) return false;
  const filter: Record<string, unknown> = { handle: normalized };
  if (excludeUserId) filter._id = { $ne: excludeUserId };
  return !(await UserModel.exists(filter));
}

export async function assertHandleAvailable(
  handle: string,
  excludeUserId?: Types.ObjectId,
): Promise<void> {
  if (!(await isHandleAvailable(handle, excludeUserId))) {
    throw conflict('handle_taken', 'That handle is not available.');
  }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export async function registerWithPassword(input: {
  email: string;
  password: string;
  handle: string;
}): Promise<UserDoc> {
  const email = normalizeEmail(input.email);
  const handle = normalizeHandle(input.handle);

  if (await UserModel.exists({ email })) {
    throw conflict('email_taken', 'An account with that email already exists.');
  }
  await assertHandleAvailable(handle);

  try {
    return await UserModel.create({
      email,
      handle,
      passwordHash: await hashPassword(input.password),
    });
  } catch (err) {
    // Two registrations raced past the pre-checks; the unique index is the truth.
    if (isDuplicateKey(err)) throw conflict('conflict', 'That email or handle is already taken.');
    throw err;
  }
}

/** Same error for unknown email, wrong password, or passwordless account: no enumeration. */
export async function loginWithPassword(input: {
  email: string;
  password: string;
}): Promise<UserDoc> {
  const user = await UserModel.findOne({ email: normalizeEmail(input.email), deletedAt: null });
  const ok = user?.passwordHash ? await verifyPassword(user.passwordHash, input.password) : false;
  if (!user || !ok) throw unauthorized('Email or password is incorrect.');
  return user;
}

function generatedHandle(): string {
  return `vg_${randomBytes(4).toString('hex')}`;
}

/**
 * Apple / Google sign-in. `email` must come from the verified token payload,
 * never from the request body. Link order: existing provider subject first,
 * then a verified email match, then a fresh account (email may be absent).
 */
export async function signInWithProvider(input: {
  provider: 'apple' | 'google';
  subject: string;
  email?: string;
  emailVerified: boolean;
}): Promise<{ user: UserDoc; created: boolean }> {
  const link = { provider: input.provider, subject: input.subject };
  const email = input.email ? normalizeEmail(input.email) : undefined;
  const verifiedEmail = input.emailVerified ? email : undefined;

  const bySubject = await UserModel.findOne({
    providers: { $elemMatch: link },
    deletedAt: null,
  });
  if (bySubject) return { user: bySubject, created: false };

  const byEmail = verifiedEmail ? await linkProviderByEmail(verifiedEmail, link) : null;
  if (byEmail) return { user: byEmail, created: false };

  if (email && !verifiedEmail && (await UserModel.exists({ email }))) {
    throw new AppError(409, 'email_unverified', 'Verify this email with the provider first.');
  }

  return { user: await createProviderUser(verifiedEmail, link), created: true };
}

type ProviderLink = { provider: 'apple' | 'google'; subject: string };

/** Attach a provider to the existing account that owns this verified email. */
async function linkProviderByEmail(email: string, link: ProviderLink): Promise<UserDoc | null> {
  const user = await UserModel.findOne({ email, deletedAt: null });
  if (!user) return null;
  user.providers.push(link);
  if (!user.emailVerifiedAt) user.emailVerifiedAt = new Date();
  await user.save();
  return user;
}

/** New account from a provider token. Retries only on a generated-handle collision. */
async function createProviderUser(
  verifiedEmail: string | undefined,
  link: ProviderLink,
): Promise<UserDoc> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await UserModel.create({
        email: verifiedEmail,
        emailVerifiedAt: verifiedEmail ? new Date() : undefined,
        handle: generatedHandle(),
        providers: [link],
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
  throw new AppError(500, 'internal_error', 'Could not create the account.');
}

/** The member's own view of their record. Never sent to anyone else. */
export function toPrivateUser(user: UserDoc) {
  return {
    id: user._id.toHexString(),
    email: user.email ?? null,
    emailVerified: Boolean(user.emailVerifiedAt),
    handle: user.handle,
    avatarKey: user.avatarKey ?? null,
    homeArea: user.homeArea,
    discoverable: user.discoverable,
    publicPostsEnabled: user.publicPostsEnabled,
    role: user.role,
    interests: user.interests,
    providers: user.providers.map((p) => p.provider),
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
  };
}

/**
 * Spec rule 10: hard delete. Everything the member authored goes; the public
 * catalogue rows they contributed (places, reviews, reports) stay, detached.
 * Order matters only for readability: each step is idempotent.
 */
export async function deleteAccount(userId: Types.ObjectId): Promise<void> {
  const ownPosts = await PostModel.find({ userId }).select('_id').lean();
  const postIds = ownPosts.map((p) => p._id);
  const conversations = await ConversationModel.find({ participantIds: userId })
    .select('_id')
    .lean();
  const conversationIds = conversations.map((c) => c._id);

  await Promise.all([
    SessionModel.deleteMany({ userId }),
    FriendshipModel.deleteMany({ $or: [{ userA: userId }, { userB: userId }] }),
    FriendInviteModel.deleteMany({ userId }),
    EventRsvpModel.deleteMany({ userId }),
    GroveMemberModel.deleteMany({ userId }),
    CommentModel.deleteMany({ $or: [{ userId }, { postId: { $in: postIds } }] }),
    ReactionModel.deleteMany({ $or: [{ userId }, { postId: { $in: postIds } }] }),
    SavedPostModel.deleteMany({ $or: [{ userId }, { postId: { $in: postIds } }] }),
    PostModel.deleteMany({ userId }),
    MessageModel.deleteMany({
      $or: [{ senderId: userId }, { conversationId: { $in: conversationIds } }],
    }),
    ConversationModel.deleteMany({ _id: { $in: conversationIds } }),
    ActionLogModel.deleteMany({ userId }),
    CompanionConversationModel.deleteMany({ userId }),
    PlaceListModel.deleteMany({ userId }),
    PushTokenModel.deleteMany({ userId }),
    NotificationPreferencesModel.deleteMany({ userId }),
    ScheduledNotificationModel.deleteMany({ userId }),
    PlaceModel.updateMany({ submittedBy: userId }, { $unset: { submittedBy: 1 } }),
    PlaceReviewModel.updateMany({ userId }, { $unset: { userId: 1 } }),
    ReportModel.updateMany({ reportedBy: userId }, { $unset: { reportedBy: 1 } }),
    EventModel.updateMany({ createdBy: userId }, { $unset: { createdBy: 1 } }),
    OrganizationModel.updateMany({ adminUserIds: userId }, { $pull: { adminUserIds: userId } }),
  ]);

  await UserModel.deleteOne({ _id: userId });
}
