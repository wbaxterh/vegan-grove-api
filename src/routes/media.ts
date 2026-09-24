import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { paginationQuery, slugParams } from '../lib/schemas.js';
import { validate } from '../middleware/validate.js';
import { MEDIA_KINDS } from '../models/index.js';

const listQuery = paginationQuery.extend({
  kind: z.enum(MEDIA_KINDS).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
});

// TODO(m2): media library. Published items only; trailers embed via youtube-nocookie.com.
export function mediaRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), notImplemented);
  router.get('/:slug', validate({ params: slugParams }), notImplemented);

  return router;
}
