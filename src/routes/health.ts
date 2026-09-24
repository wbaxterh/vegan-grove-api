import { Router } from 'express';
import { pingDb } from '../db/mongoose.js';
import type { AppDeps } from '../lib/deps.js';

/** `GET /healthz`: 200 `{ ok: true }` only when the database answers a ping. */
export function healthRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      await pingDb();
      res.json({ ok: true });
    } catch (err) {
      deps.logger.error({ err }, 'healthz: db ping failed');
      res
        .status(503)
        .json({ ok: false, error: { code: 'db_unavailable', message: 'Database ping failed.' } });
    }
  });

  return router;
}
