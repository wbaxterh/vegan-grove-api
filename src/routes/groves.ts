import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound, notImplemented } from '../lib/errors.js';
import { idParams, paginationQuery, slugParams } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { getValidated, validate } from '../middleware/validate.js';
import { HOME_AREAS } from '../models/index.js';
import { getGroveBySlug, listGroves } from '../services/catalogue.js';

const listQuery = paginationQuery.extend({ area: z.enum(HOME_AREAS).optional() });

/** Public listing with member counts; membership itself is private. */
export function grovesRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    res.json(await listGroves(query));
  });

  router.get('/:slug', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const grove = await getGroveBySlug(params.slug);
    if (!grove) throw notFound('Grove not found.');
    res.json({ grove });
  });

  // TODO(m2): join and leave, keeping memberCount derived.
  router.post('/:id/join', auth, validate({ params: idParams }), notImplemented);
  router.delete('/:id/leave', auth, validate({ params: idParams }), notImplemented);

  return router;
}
