import { z } from 'zod';

/**
 * Every environment variable the API reads, validated once at boot.
 * A missing or malformed value fails fast with a readable message instead of
 * surfacing later as an undefined bucket name or an unset encryption key.
 */

const csv = (value: unknown) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes, base64 encoded',
  })
  .optional();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    CORS_ORIGINS: z.preprocess(csv, z.array(z.url()).default([])),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    MONGODB_DB_NAME: optionalString,

    SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(30),
    MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(1).default(15),
    MAGIC_LINK_BASE_URL: z.url().default('http://localhost:3000/auth/magic'),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_MAGIC_LINK_MAX: z.coerce.number().int().min(1).default(5),
    RATE_LIMIT_COMPANION_MAX: z.coerce.number().int().min(1).default(60),

    EMAIL_TRANSPORT: z.enum(['smtp', 'log']).default('log'),
    EMAIL_FROM: z.string().default('Vegan Grove <no-reply@vegangrove.org>'),
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,

    AWS_REGION: z.string().default('us-east-1'),
    S3_MEDIA_BUCKET: optionalString,
    S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    BUNNY_STREAM_LIBRARY_ID: optionalString,
    BUNNY_STREAM_API_KEY: optionalString,

    ANTHROPIC_API_KEY: optionalString,
    COMPANION_MODEL: z.string().default('claude-opus-5'),
    COMPANION_MAX_TOKENS: z.coerce.number().int().min(256).max(128000).default(8192),
    COMPANION_HISTORY_LIMIT: z.coerce.number().int().min(2).max(100).default(20),

    DM_ENCRYPTION_KEY: base64Key32,
    DM_KEY_ID: z.string().default('v1'),
    DM_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

    APPLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_IDS: z.preprocess(csv, z.array(z.string()).default([])),

    OVERPASS_URL: z.url().default('https://overpass.kumi.systems/api/interpreter'),
    STATS_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(5 * 60 * 1000),
    REMINDER_TICK_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(60 * 1000),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_TRANSPORT === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when EMAIL_TRANSPORT=smtp`,
          });
        }
      }
    }
    if (env.NODE_ENV === 'production') {
      if (!env.DM_ENCRYPTION_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['DM_ENCRYPTION_KEY'],
          message: 'required in production',
        });
      }
      if (env.EMAIL_TRANSPORT === 'log') {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_TRANSPORT'],
          message: 'must be smtp in production',
        });
      }
      if (env.CORS_ORIGINS.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'required in production' });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

/**
 * Parse and validate the environment. Throws `EnvError` listing every problem.
 * Empty values (`KEY=` in a .env file) count as unset so defaults still apply.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvError(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
