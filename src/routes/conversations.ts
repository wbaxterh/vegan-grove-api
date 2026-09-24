import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { idParams, objectIdSchema, paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { MESSAGE_TYPES } from '../models/index.js';

const createBody = z.object({ userId: objectIdSchema }).strict();

const messageBody = z
  .object({
    type: z.enum(MESSAGE_TYPES).default('text'),
    content: z.string().min(1).max(4000),
  })
  .strict();

// TODO(m2): DMs. Bodies are encrypted at rest with `services/crypto/dm.ts`
// (ready) and expire after `DM_RETENTION_DAYS`; a conversation requires an
// accepted friendship between the two participants.
export function conversationsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.get('/', validate({ query: paginationQuery }), notImplemented);
  router.post('/', validate({ body: createBody }), notImplemented);
  router.get(
    '/:id/messages',
    validate({ params: idParams, query: paginationQuery }),
    notImplemented,
  );
  router.post('/:id/messages', validate({ params: idParams, body: messageBody }), notImplemented);

  return router;
}
