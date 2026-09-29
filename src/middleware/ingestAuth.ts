import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { AppDeps } from '../lib/deps.js';
import { unauthorized, unavailable } from '../lib/errors.js';
import { bearerToken, requireAuth } from './auth.js';
import { requireAdmin } from './requireAdmin.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time comparison. Hashing first hides the length of the two strings. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Who may ingest: the bot, with `X-Ingest-Key` matching `INGEST_KEY` in
 * constant time, or an admin session. Nothing is read from the body. Until
 * `INGEST_KEY` exists the key path answers 503 so a misconfigured host is
 * loud rather than silently open.
 */
export function requireIngestPrincipal(deps: Pick<AppDeps, 'env'>): RequestHandler {
  const auth = requireAuth(deps);
  return (req, res, next) => {
    if (bearerToken(req.header('authorization'))) {
      auth(req, res, (err?: unknown) => (err ? next(err) : requireAdmin(req, res, next)));
      return;
    }
    const configured = deps.env.INGEST_KEY;
    if (!configured) {
      return next(unavailable('ingest_unconfigured', 'Ingest is not configured.'));
    }
    const presented = req.header('x-ingest-key');
    if (presented === undefined) {
      return next(unauthorized('An ingest key or an admin session is required.'));
    }
    if (!safeEqual(presented, configured)) return next(unauthorized('Invalid ingest key.'));
    // Rate limits key on a fingerprint of the key, never the key itself.
    req.ingestKeyId = digest(presented).toString('hex').slice(0, 16);
    next();
  };
}
