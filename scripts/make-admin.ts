/**
 * Promote an existing member to admin by email.
 *
 *   npm run make-admin -- someone@example.org
 *
 * The member signs up through the app first; this only flips `role`. There is
 * deliberately no way to create an account or set a password from here.
 */
import { config as loadDotenv } from 'dotenv';
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/mongoose.js';
import { createLogger } from '../src/lib/logger.js';
import { UserModel } from '../src/models/index.js';

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    process.stderr.write('usage: npm run make-admin -- <email>\n');
    process.exit(2);
  }
  const env = loadEnv(process.env);
  const logger = createLogger({ NODE_ENV: env.NODE_ENV, LOG_LEVEL: 'info' });
  await connectDb(env, logger);
  try {
    const user = await UserModel.findOneAndUpdate(
      { email, deletedAt: { $exists: false } },
      { $set: { role: 'admin' } },
      { new: true },
    )
      .select('handle role')
      .lean();
    if (!user) {
      logger.error('no active member with that email; sign up first');
      process.exitCode = 1;
      return;
    }
    logger.info({ handle: user.handle, role: user.role }, 'member is now admin');
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  process.stderr.write(`make-admin failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
