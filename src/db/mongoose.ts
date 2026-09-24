import mongoose from 'mongoose';
import type { Env } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import { ensureIndexes } from '../models/index.js';

/**
 * One connection for the process. Mongoose pools internally, so services and
 * routes import models directly instead of threading a client around.
 */
export async function connectDb(
  env: Pick<Env, 'MONGODB_URI' | 'MONGODB_DB_NAME'>,
  logger: Logger,
): Promise<typeof mongoose> {
  // No global sanitizeFilter: it rewrites legitimate operators like `$gt` into
  // `$eq`. Operator injection is prevented at the boundary instead, where zod
  // types every value that can reach a filter.
  mongoose.set('strictQuery', true);
  mongoose.set('autoIndex', false);

  const conn = await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DB_NAME,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
  });

  await ensureIndexes();
  logger.info({ db: conn.connection.name }, 'mongo connected');

  conn.connection.on('error', (err) => logger.error({ err }, 'mongo connection error'));
  conn.connection.on('disconnected', () => logger.warn('mongo disconnected'));
  return conn;
}

/** Round-trip to the server; used by /healthz. Throws when the DB is unreachable. */
export async function pingDb(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) {
    throw new Error('mongo not connected');
  }
  await db.admin().ping();
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
