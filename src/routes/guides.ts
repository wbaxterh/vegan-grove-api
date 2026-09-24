import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { paginationQuery, slugParams } from '../lib/schemas.js';
import { validate } from '../middleware/validate.js';
import { GUIDE_CATEGORIES } from '../models/index.js';

const listQuery = paginationQuery.extend({ category: z.enum(GUIDE_CATEGORIES).optional() });

// TODO(m2): guides. Published only; markdown body rendered by the clients.
export function guidesRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), notImplemented);
  router.get('/:slug', validate({ params: slugParams }), notImplemented);

  return router;
}
