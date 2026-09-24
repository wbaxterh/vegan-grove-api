import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { idParams, objectIdSchema, paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { MEDIA_TYPES, POST_VISIBILITIES } from '../models/index.js';

const createBody = z
  .object({
    mediaType: z.enum(MEDIA_TYPES),
    imageKeys: z.array(z.string().max(200)).max(10).default([]),
    bunnyVideoId: z.string().max(64).optional(),
    caption: z.string().trim().max(2200).default(''),
    visibility: z.enum(POST_VISIBILITIES).default('friends'),
    groveId: objectIdSchema.optional(),
    placeId: objectIdSchema.optional(),
    eventId: objectIdSchema.optional(),
  })
  .strict();

const commentBody = z
  .object({
    content: z.string().trim().min(1).max(500),
    parentId: objectIdSchema.optional(),
  })
  .strict();

// TODO(m2): posts, reactions, comments, saves. `public` visibility requires the
// author's `publicPostsEnabled` switch, checked server-side on create.
export function postsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.post('/', validate({ body: createBody }), notImplemented);
  router.get('/:id', validate({ params: idParams }), notImplemented);
  router.delete('/:id', validate({ params: idParams }), notImplemented);
  router.post('/:id/reactions', validate({ params: idParams }), notImplemented);
  router.delete('/:id/reactions', validate({ params: idParams }), notImplemented);
  router.get(
    '/:id/comments',
    validate({ params: idParams, query: paginationQuery }),
    notImplemented,
  );
  router.post('/:id/comments', validate({ params: idParams, body: commentBody }), notImplemented);
  router.post('/:id/save', validate({ params: idParams }), notImplemented);
  router.delete('/:id/save', validate({ params: idParams }), notImplemented);

  return router;
}
