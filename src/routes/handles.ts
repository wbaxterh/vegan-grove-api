import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { handleSchema, paginationQuery } from '../lib/schemas.js';
import { validate } from '../middleware/validate.js';

const handleParams = z.object({ handle: handleSchema });

// TODO(m2): a handle's public posts. Privacy rule 1: the response carries the
// handle, the avatar, and public posts. No bio, area, friends, or counts, ever.
export function handlesRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get(
    '/:handle/posts',
    validate({ params: handleParams, query: paginationQuery }),
    notImplemented,
  );

  return router;
}
