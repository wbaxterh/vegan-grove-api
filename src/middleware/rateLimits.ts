import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const WINDOW_MS = 15 * 60 * 1000;

const rateLimited = new AppError(429, 'rate_limited', 'Too many requests. Try again later.');

function limiter(limit: number, keyByUser: boolean) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyByUser
      ? {
          keyGenerator: (req) =>
            req.auth?.user._id.toHexString() ?? ipKeyGenerator(req.ip ?? '', 56),
        }
      : {}),
    handler: (_req, res) => {
      res.status(429).json(rateLimited.toBody());
    },
  });
}

/**
 * Per-IP limits on the credential-bearing routes and a per-user limit on the
 * companion, which spends money per call. Sits behind `trust proxy`.
 */
export function createRateLimiters(
  env: Pick<Env, 'RATE_LIMIT_AUTH_MAX' | 'RATE_LIMIT_MAGIC_LINK_MAX' | 'RATE_LIMIT_COMPANION_MAX'>,
) {
  return {
    auth: limiter(env.RATE_LIMIT_AUTH_MAX, false),
    magicLink: limiter(env.RATE_LIMIT_MAGIC_LINK_MAX, false),
    companion: limiter(env.RATE_LIMIT_COMPANION_MAX, true),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
