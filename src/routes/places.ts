import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound, notImplemented } from '../lib/errors.js';
import { bboxSchema, idParams, paginationQuery, pointInput, slugParams } from '../lib/schemas.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { getValidated, validate } from '../middleware/validate.js';
import { HOME_AREAS, PLACE_TYPES, VEGAN_LEVELS } from '../models/index.js';
import { getApprovedPlaceBySlug, listApprovedPlaces, submitPlace } from '../services/places.js';

const listQuery = paginationQuery.extend({
  bbox: bboxSchema,
  type: z.enum(PLACE_TYPES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
});

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(PLACE_TYPES),
    veganLevel: z.enum(VEGAN_LEVELS),
    location: pointInput,
    address: z.string().trim().max(240).optional(),
    city: z.string().trim().max(80).optional(),
    area: z.enum(HOME_AREAS).optional(),
    website: z.url().max(300).optional(),
    hours: z.string().trim().max(200).optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    description: z.string().trim().max(2000).optional(),
    photoKeys: z.array(z.string().max(200)).max(10).optional(),
  })
  .strict();

const reviewBody = z
  .object({
    rating: z.number().int().min(1).max(5),
    content: z.string().trim().max(1000).default(''),
    visitedMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    showHandle: z.boolean().default(false),
  })
  .strict();

/** The map. Reads are public and approved-only; submissions queue for moderation. */
export function placesRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    res.json(await listApprovedPlaces(query));
  });

  router.get('/:slug', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const place = await getApprovedPlaceBySlug(params.slug);
    if (!place) throw notFound('Place not found.');
    res.json({ place });
  });

  router.post('/', requireAuth(deps), validate({ body: createBody }), async (req, res) => {
    const { body } = getValidated<{ body: z.infer<typeof createBody> }>(req);
    const place = await submitPlace(body, currentUser(req)._id);
    res.status(201).json({ place });
  });

  // TODO(m2): reviews list and create (pseudonymous, opt-in handle per review).
  router.get(
    '/:id/reviews',
    validate({ params: idParams, query: paginationQuery }),
    notImplemented,
  );
  router.post(
    '/:id/reviews',
    requireAuth(deps),
    validate({ params: idParams, body: reviewBody }),
    notImplemented,
  );

  return router;
}
