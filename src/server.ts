import { createServer } from 'node:http';
import { config as loadDotenv } from 'dotenv';
import { buildApp } from './app.js';
import { EnvError, loadEnv } from './config/env.js';
import { connectDb, disconnectDb } from './db/mongoose.js';
import type { AppDeps } from './lib/deps.js';
import { createLogger } from './lib/logger.js';
import { createCompanionService } from './services/companion/index.js';
import { createEmailSender } from './services/email.js';
import { createSocketServer } from './socket/index.js';
import { createReminderSender } from './workers/reminderSender.js';

const SHUTDOWN_FORCE_MS = 10_000;

async function main(): Promise<void> {
  loadDotenv({ quiet: true });

  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(env);
  await connectDb(env, logger);

  const deps: AppDeps = {
    env,
    logger,
    email: createEmailSender(env, logger),
    companion: createCompanionService(env, logger),
  };

  const app = buildApp(deps);
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer, deps);
  const reminders = createReminderSender(deps);

  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'vegan-grove-api listening');
    reminders.start();
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_FORCE_MS);
    force.unref();

    try {
      await reminders.stop();
      await io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await disconnectDb();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
