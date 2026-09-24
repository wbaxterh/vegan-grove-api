import type { Request, RequestHandler } from 'express';
import type { AppDeps } from '../lib/deps.js';
import { unauthorized } from '../lib/errors.js';
import { type SessionDoc, type UserDoc, UserModel } from '../models/index.js';
import { resolveSession } from '../services/sessions.js';

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * Resolve `Authorization: Bearer <token>` to a live session and a live user.
 * The user is loaded from the database on every request, so a role change or
 * a deletion takes effect immediately; nothing is trusted from the token.
 */
export function requireAuth(deps: Pick<AppDeps, 'env'>): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req.header('authorization'));
    if (!token) return next(unauthorized());

    const session = await resolveSession(token, deps.env.SESSION_TTL_DAYS);
    if (!session) return next(unauthorized('Session is invalid or expired.'));

    const user = await UserModel.findOne({ _id: session.userId, deletedAt: null });
    if (!user) return next(unauthorized('Session is invalid or expired.'));

    req.auth = { user, session };
    next();
  };
}

/** The authenticated principal. Throws if used on a route without `requireAuth`. */
export function currentUser(req: Request): UserDoc {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

export function currentSession(req: Request): SessionDoc {
  if (!req.auth) throw unauthorized();
  return req.auth.session;
}
