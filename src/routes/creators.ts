import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { AppError, notFound } from '../lib/errors.js';
import { paginationQuery, slugParams } from '../lib/schemas.js';
import { getValidated, validate } from '../middleware/validate.js';
import { getCreatorBySlug, listCreators } from '../services/creators.js';

const listQuery = paginationQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  topic: z.string().trim().min(1).max(60).optional(),
  lang: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}$/)
    .optional(),
  country: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  q: z.string().trim().min(2).max(80).optional(),
});

const PUBLIC_CACHE = 'public, max-age=300, stale-while-revalidate=3600';

export function creatorsRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json(await listCreators(query));
  });

  router.get('/:slug', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const { creator, retired } = await getCreatorBySlug(params.slug);
    if (retired) {
      throw new AppError(410, 'creator_retired', 'This creator entry has been retired.');
    }
    if (!creator) throw notFound('Creator not found.');
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ creator });
  });

  return router;
}
