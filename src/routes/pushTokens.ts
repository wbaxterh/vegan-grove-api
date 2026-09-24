import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { PUSH_PLATFORMS } from '../models/index.js';

const tokenBody = z
  .object({
    token: z.string().min(10).max(512),
    platform: z.enum(PUSH_PLATFORMS),
  })
  .strict();

const deleteBody = z.object({ token: z.string().min(10).max(512) }).strict();

// TODO(m2): push token registration; the reminder worker reads live tokens from here.
export function pushTokensRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.post('/', validate({ body: tokenBody }), notImplemented);
  router.delete('/', validate({ body: deleteBody }), notImplemented);

  return router;
}
