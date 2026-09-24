import { createHash, randomBytes } from 'node:crypto';
import { type Client, type SessionDoc, SessionModel, type Types } from '../models/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Only touch the row when the last write is older than this: one write per 5 min per session. */
const SLIDE_AFTER_MS = 5 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Create a session and return the plaintext token exactly once. */
export async function createSession(
  userId: Types.ObjectId,
  client: Client,
  ttlDays: number,
): Promise<{ token: string; session: SessionDoc }> {
  const token = generateSessionToken();
  const session = await SessionModel.create({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlDays * DAY_MS),
    lastSeenAt: new Date(),
    client,
  });
  return { token, session };
}

/**
 * Look a token up by hash. Sliding expiry: a session used within its window
 * gets pushed out another `ttlDays`, throttled to avoid a write per request.
 */
export async function resolveSession(token: string, ttlDays: number): Promise<SessionDoc | null> {
  const now = new Date();
  const session = await SessionModel.findOne({
    tokenHash: hashToken(token),
    expiresAt: { $gt: now },
  });
  if (!session) return null;

  if (now.getTime() - session.lastSeenAt.getTime() > SLIDE_AFTER_MS) {
    session.lastSeenAt = now;
    session.expiresAt = new Date(now.getTime() + ttlDays * DAY_MS);
    await session.save();
  }
  return session;
}

export interface SessionSummary {
  id: string;
  client: Client;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  current: boolean;
}

export async function listSessions(
  userId: Types.ObjectId,
  currentSessionId: Types.ObjectId,
): Promise<SessionSummary[]> {
  const rows = await SessionModel.find({ userId, expiresAt: { $gt: new Date() } }).sort({
    lastSeenAt: -1,
  });
  return rows.map((s) => ({
    id: s._id.toHexString(),
    client: s.client,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    current: s._id.equals(currentSessionId),
  }));
}

/** Revoke one of the caller's own sessions. Returns false when it was not theirs. */
export async function revokeSession(
  userId: Types.ObjectId,
  sessionId: Types.ObjectId,
): Promise<boolean> {
  const result = await SessionModel.deleteOne({ _id: sessionId, userId });
  return result.deletedCount === 1;
}

export async function revokeAllSessions(userId: Types.ObjectId): Promise<number> {
  const result = await SessionModel.deleteMany({ userId });
  return result.deletedCount;
}
