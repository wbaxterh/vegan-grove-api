import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { idParams, paginationQuery, slugParams } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HOME_AREAS } from '../models/index.js';

const listQuery = paginationQuery.extend({ area: z.enum(HOME_AREAS).optional() });

// TODO(m2): groves. Public listing with member counts; membership itself is private.
export function grovesRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);

  router.get('/', validate({ query: listQuery }), notImplemented);
  router.get('/:slug', validate({ params: slugParams }), notImplemented);
  router.post('/:id/join', auth, validate({ params: idParams }), notImplemented);
  router.delete('/:id/leave', auth, validate({ params: idParams }), notImplemented);

  return router;
}
