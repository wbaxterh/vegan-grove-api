import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

/** `friends`, `public`, or `grove:<id>`. */
const scopeSchema = z
  .string()
  .regex(/^(friends|public|grove:[a-f0-9]{24})$/, 'scope must be friends, public or grove:<id>');

const feedQuery = paginationQuery.extend({ scope: scopeSchema.default('friends') });

// TODO(m2): feed. Every scope is filtered by visibility server-side before it leaves.
export function feedRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.get('/', validate({ query: feedQuery }), notImplemented);

  return router;
}
