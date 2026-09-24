import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { idParams, objectIdSchema, paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const createBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    placeIds: z.array(objectIdSchema).max(500).default([]),
    isPublic: z.boolean().default(false),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    placeIds: z.array(objectIdSchema).max(500).optional(),
    isPublic: z.boolean().optional(),
  })
  .strict();

// TODO(m2): place lists. Private by default; only the owner reads their lists.
export function placeListsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.get('/', validate({ query: paginationQuery }), notImplemented);
  router.post('/', validate({ body: createBody }), notImplemented);
  router.patch('/:id', validate({ params: idParams, body: patchBody }), notImplemented);
  router.delete('/:id', validate({ params: idParams }), notImplemented);

  return router;
}
