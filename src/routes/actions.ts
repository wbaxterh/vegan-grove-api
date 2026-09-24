import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { idParams, objectIdSchema, paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ACTION_TYPES } from '../models/index.js';

const createBody = z
  .object({
    type: z.enum(ACTION_TYPES),
    eventId: objectIdSchema.optional(),
    hours: z.number().min(0).max(24).optional(),
    note: z.string().trim().max(500).optional(),
    occurredAt: z.iso.datetime(),
  })
  .strict();

// TODO(m2): the private action log. Owner-only reads; aggregates need explicit opt-in.
export function actionsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.get('/', validate({ query: paginationQuery }), notImplemented);
  router.post('/', validate({ body: createBody }), notImplemented);
  router.delete('/:id', validate({ params: idParams }), notImplemented);

  return router;
}
