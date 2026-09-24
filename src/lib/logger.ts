import { type Logger as PinoLogger, pino } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Redaction is the privacy floor for logs (spec rule 8): tokens, passwords and
 * emails never reach stdout, and request bodies are never serialized at all.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.email',
  '*.token',
  '*.identityToken',
  '*.idToken',
  'password',
  'email',
  'token',
];

export type Logger = PinoLogger;

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'vegan-grove-api' },
  });
}
