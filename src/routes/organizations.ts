import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound } from '../lib/errors.js';
import { paginationQuery, slugParams } from '../lib/schemas.js';
import { getValidated, validate } from '../middleware/validate.js';
import { ORGANIZATION_TYPES } from '../models/index.js';
import { getOrganizationBySlug, listOrganizations } from '../services/catalogue.js';

const listQuery = paginationQuery.extend({ type: z.enum(ORGANIZATION_TYPES).optional() });

/** Public directory, verified first. `adminUserIds` is never serialized. */
export function organizationsRouter(_deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    res.json(await listOrganizations(query));
  });

  router.get('/:slug', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const organization = await getOrganizationBySlug(params.slug);
    if (!organization) throw notFound('Organization not found.');
    res.json({ organization });
  });

  return router;
}
