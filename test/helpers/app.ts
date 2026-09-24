import { randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import mongoose from 'mongoose';
import supertest from 'supertest';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { type Env, loadEnv } from '../../src/config/env.js';
import { connectDb, disconnectDb } from '../../src/db/mongoose.js';
import type { EmailSender } from '../../src/lib/deps.js';
import { createLogger } from '../../src/lib/logger.js';
import { type Types, UserModel } from '../../src/models/index.js';
import type {
  CompanionInput,
  CompanionResult,
  CompanionService,
} from '../../src/services/companion/types.js';

export interface CapturedEmail {
  to: string;
  url: string;
}

export interface FakeCompanion extends CompanionService {
  calls: CompanionInput[];
}

/** A scripted companion: yields `chunks`, records what it was asked, returns `result`. */
export function fakeCompanion(
  chunks: string[],
  result: CompanionResult = { stopReason: 'end_turn' },
  failWith?: Error,
): FakeCompanion {
  const calls: CompanionInput[] = [];
  return {
    calls,
    async *streamCompanionReply(input) {
      calls.push(input);
      if (failWith) throw failWith;
      for (const chunk of chunks) yield chunk;
      return result;
    },
  };
}

export interface TestContext {
  app: Express;
  env: Env;
  emails: CapturedEmail[];
  setCompanion(next: CompanionService): void;
  /** Wipe every collection between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export const TEST_DM_KEY = randomBytes(32).toString('base64');

export async function createTestContext(): Promise<TestContext> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: inject('mongoUri'),
    MONGODB_DB_NAME: `vg_test_${randomUUID().slice(0, 8)}`,
    CORS_ORIGINS: 'http://localhost:3000',
    EMAIL_TRANSPORT: 'log',
    RATE_LIMIT_AUTH_MAX: '10000',
    RATE_LIMIT_MAGIC_LINK_MAX: '10000',
    RATE_LIMIT_COMPANION_MAX: '10000',
    STATS_CACHE_TTL_MS: '300000',
    DM_ENCRYPTION_KEY: TEST_DM_KEY,
  });
  const logger = createLogger(env);
  await connectDb(env, logger);

  const emails: CapturedEmail[] = [];
  const email: EmailSender = {
    async sendMagicLink({ to, url }) {
      emails.push({ to, url });
    },
  };

  let companion: CompanionService = fakeCompanion(['Hi there.']);
  const companionProxy: CompanionService = {
    streamCompanionReply: (input, options) => companion.streamCompanionReply(input, options),
  };

  const app = buildApp({ env, logger, email, companion: companionProxy });

  return {
    app,
    env,
    emails,
    setCompanion(next) {
      companion = next;
    },
    async reset() {
      emails.length = 0;
      const collections = await mongoose.connection.db?.collections();
      await Promise.all((collections ?? []).map((c) => c.deleteMany({})));
    },
    async close() {
      await mongoose.connection.db?.dropDatabase();
      await disconnectDb();
    },
  };
}

export interface RegisteredUser {
  token: string;
  id: string;
  email: string;
  handle: string;
}

let counter = 0;

/** Register a fresh member through the real endpoint and hand back the token. */
export async function registerUser(
  app: Express,
  overrides: Partial<{ email: string; password: string; handle: string }> = {},
): Promise<RegisteredUser> {
  counter += 1;
  const body = {
    email: `member${counter}@example.org`,
    password: 'correct horse battery',
    handle: `member_${counter}`,
    ...overrides,
  };
  const res = await supertest(app).post('/api/auth/register').send(body);
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.token,
    id: res.body.user.id,
    email: res.body.user.email,
    handle: res.body.user.handle,
  };
}

export async function promoteToAdmin(userId: string | Types.ObjectId): Promise<void> {
  await UserModel.updateOne({ _id: userId }, { $set: { role: 'admin' } });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Collect an SSE response body as text (supertest does not parse event streams). */
export function collectSse(
  res: supertest.Response,
  cb: (err: Error | null, body: unknown) => void,
) {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => cb(null, data));
}
