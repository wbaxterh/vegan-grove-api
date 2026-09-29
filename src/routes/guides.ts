import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound } from '../lib/errors.js';
import { paginationQuery, slugParams } from '../lib/schemas.js';
import { getValidated, validate } from '../middleware/validate.js';
import { GUIDE_CATEGORIES } from '../models/index.js';
import { getPublishedGuideBySlug, listPublishedGuides } from '../services/catalogue.js';

const listQuery = paginationQuery.extend({ category: z.enum(GUIDE_CATEGORIES).optional() });

/** Guides. Published only; the list omits the markdown body, the detail carries it. */
export function guidesRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    res.json(await listPublishedGuides(query));
  });

  router.get('/:slug', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const guide = await getPublishedGuideBySlug(params.slug);
    if (!guide) throw notFound('Guide not found.');
    res.json({ guide });
  });

  return router;
}
