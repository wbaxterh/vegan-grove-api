import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppDeps } from './lib/deps.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { actionsRouter } from './routes/actions.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { companionRouter } from './routes/companion.js';
import { conversationsRouter } from './routes/conversations.js';
import { eventsRouter } from './routes/events.js';
import { feedRouter } from './routes/feed.js';
import { friendsRouter } from './routes/friends.js';
import { grovesRouter } from './routes/groves.js';
import { guidesRouter } from './routes/guides.js';
import { handlesRouter } from './routes/handles.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';
import { mediaRouter } from './routes/media.js';
import { organizationsRouter } from './routes/organizations.js';
import { placeListsRouter } from './routes/placeLists.js';
import { placesRouter } from './routes/places.js';
import { postsRouter } from './routes/posts.js';
import { pushTokensRouter } from './routes/pushTokens.js';
import { reportsRouter } from './routes/reports.js';
import { statsRouter } from './routes/stats.js';
import { uploadsRouter } from './routes/uploads.js';

/**
 * Build the Express app without listening, so tests can mount it on supertest
 * and `server.ts` can attach Socket.IO and workers around it.
 */
export function buildApp(deps: AppDeps): Express {
  const app = express();
  const { env } = deps;

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header means a native app or curl; browsers always send one.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        callback(null, false);
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  // Request logging: id, method, path and status only. No query string (bbox
  // is location), no headers, no body, no client address.
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: () => randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use('/healthz', healthRouter(deps));
  app.use('/api/stats', statsRouter(deps));
  app.use('/api/auth', authRouter(deps));
  app.use('/api/me', meRouter(deps));
  app.use('/api/places', placesRouter(deps));
  app.use('/api/place-lists', placeListsRouter(deps));
  app.use('/api/events', eventsRouter(deps));
  app.use('/api/groves', grovesRouter(deps));
  app.use('/api/organizations', organizationsRouter(deps));
  app.use('/api/friends', friendsRouter(deps));
  app.use('/api/feed', feedRouter(deps));
  app.use('/api/posts', postsRouter(deps));
  app.use('/api/handles', handlesRouter(deps));
  app.use('/api/reports', reportsRouter(deps));
  app.use('/api/uploads', uploadsRouter(deps));
  app.use('/api/conversations', conversationsRouter(deps));
  app.use('/api/media', mediaRouter(deps));
  app.use('/api/guides', guidesRouter(deps));
  app.use('/api/actions', actionsRouter(deps));
  app.use('/api/companion', companionRouter(deps));
  app.use('/api/push-tokens', pushTokensRouter(deps));
  app.use('/api/admin', adminRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
