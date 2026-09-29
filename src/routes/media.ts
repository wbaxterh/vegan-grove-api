import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound } from '../lib/errors.js';
import { paginationQuery, slugParams } from '../lib/schemas.js';
import { getValidated, validate } from '../middleware/validate.js';
import { MEDIA_KINDS } from '../models/index.js';
import { getPublishedMediaBySlug, listPublishedMedia } from '../services/catalogue.js';

const listQuery = paginationQuery.extend({
  kind: z.enum(MEDIA_KINDS).optional(),
  tag: z.string().trim().min(1).max(60).optional(),
});

/** Media library. Published items only; trailers embed via youtube-nocookie.com. */
export function mediaRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    res.json(await listPublishedMedia(query));
  });

  router.get('/:slug', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const media = await getPublishedMediaBySlug(params.slug);
    if (!media) throw notFound('Media item not found.');
    res.json({ media });
  });

  return router;
}
