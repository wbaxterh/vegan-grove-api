import { randomBytes } from 'node:crypto';
import type { AppDeps } from '../lib/deps.js';
import { MagicLinkModel, type UserDoc, UserModel } from '../models/index.js';
import { normalizeEmail } from './auth.js';
import { hashToken } from './sessions.js';

const MINUTE_MS = 60 * 1000;

/**
 * Issue a login link. The route answers 202 no matter what, so this function
 * does its work silently: no user, no email, no signal to the caller.
 */
export async function issueMagicLink(
  rawEmail: string,
  deps: Pick<AppDeps, 'env' | 'email' | 'logger'>,
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const token = randomBytes(32).toString('base64url');

  const user = await UserModel.findOne({ email, deletedAt: null }).select('_id').lean();
  if (!user) {
    deps.logger.debug('magic link requested for unknown email');
    return;
  }

  await MagicLinkModel.create({
    email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + deps.env.MAGIC_LINK_TTL_MINUTES * MINUTE_MS),
  });

  const url = new URL(deps.env.MAGIC_LINK_BASE_URL);
  url.searchParams.set('token', token);
  await deps.email.sendMagicLink({ to: email, url: url.toString() });
}

/**
 * Consume a link exactly once. The `findOneAndUpdate` on `usedAt: null` is
 * the atomic claim; a second verify with the same token finds nothing.
 */
export async function consumeMagicLink(token: string): Promise<UserDoc | null> {
  const now = new Date();
  const link = await MagicLinkModel.findOneAndUpdate(
    { tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'after' },
  );
  if (!link) return null;

  const user = await UserModel.findOne({ email: link.email, deletedAt: null });
  if (!user) return null;

  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = now;
    await user.save();
  }
  return user;
}
