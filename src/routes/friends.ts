import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { objectIdSchema, paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const codeParams = z.object({ code: z.string().regex(/^[A-Za-z0-9]{8}$/, 'invite code') });
const userIdParams = z.object({ userId: objectIdSchema });
const inviteBody = z.object({ uses: z.number().int().min(1).max(20).default(1) }).strict();

// TODO(m2): allies. Connection is by invite code only; there is no user search.
export function friendsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.get('/', validate({ query: paginationQuery }), notImplemented);
  router.get('/requests', validate({ query: paginationQuery }), notImplemented);
  router.post('/invites', validate({ body: inviteBody }), notImplemented);
  router.post('/invites/:code/accept', validate({ params: codeParams }), notImplemented);
  router.delete('/:userId', validate({ params: userIdParams }), notImplemented);

  return router;
}
