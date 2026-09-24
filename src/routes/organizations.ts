import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { paginationQuery, slugParams } from '../lib/schemas.js';
import { validate } from '../middleware/validate.js';
import { ORGANIZATION_TYPES } from '../models/index.js';

const listQuery = paginationQuery.extend({ type: z.enum(ORGANIZATION_TYPES).optional() });

// TODO(m2): organizations. Public directory; `adminUserIds` is never serialized.
export function organizationsRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), notImplemented);
  router.get('/:slug', validate({ params: slugParams }), notImplemented);

  return router;
}
