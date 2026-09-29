import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const WINDOW_MS = 15 * 60 * 1000;

const rateLimited = new AppError(429, 'rate_limited', 'Too many requests. Try again later.');

type KeyMode = 'ip' | 'user' | 'ingest';

function limiter(limit: number, mode: KeyMode) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(mode === 'ip'
      ? {}
      : {
          keyGenerator: (req) =>
            (mode === 'ingest' ? req.ingestKeyId : undefined) ??
            req.auth?.user._id.toHexString() ??
            ipKeyGenerator(req.ip ?? '', 56),
        }),
    handler: (req, res) => {
      const resetTime = (req as { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const seconds = resetTime
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(WINDOW_MS / 1000);
      res.setHeader('Retry-After', String(seconds));
      res.status(429).json(rateLimited.toBody());
    },
  });
}

/**
 * Per-IP limits on the credential-bearing routes, a per-user limit on the
 * companion (which spends money per call), and a per-key limit on ingest.
 * Sits behind `trust proxy`.
 */
export function createRateLimiters(
  env: Pick<
    Env,
    | 'RATE_LIMIT_AUTH_MAX'
    | 'RATE_LIMIT_MAGIC_LINK_MAX'
    | 'RATE_LIMIT_COMPANION_MAX'
    | 'RATE_LIMIT_INGEST_MAX'
  >,
) {
  return {
    auth: limiter(env.RATE_LIMIT_AUTH_MAX, 'ip'),
    magicLink: limiter(env.RATE_LIMIT_MAGIC_LINK_MAX, 'ip'),
    companion: limiter(env.RATE_LIMIT_COMPANION_MAX, 'user'),
    ingest: limiter(env.RATE_LIMIT_INGEST_MAX, 'ingest'),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
