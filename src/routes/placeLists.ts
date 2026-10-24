import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { idParams, objectIdSchema, paginationQuery } from '../lib/schemas.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { getValidated, validate } from '../middleware/validate.js';
import {
  addPlaceToList,
  createPlaceList,
  deletePlaceList,
  getPlaceList,
  listPlaceLists,
  removePlaceFromList,
  updatePlaceList,
} from '../services/placeLists.js';

const createBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    placeIds: z.array(objectIdSchema).max(500).default([]),
    isPublic: z.boolean().default(false),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    placeIds: z.array(objectIdSchema).max(500).optional(),
    isPublic: z.boolean().optional(),
  })
  .strict();

const addPlaceBody = z.object({ placeId: objectIdSchema }).strict();
const listPlaceParams = z.object({ id: objectIdSchema, placeId: objectIdSchema });

const PRIVATE = 'private, no-store';

/**
 * Saved places. Every route is the owner's: `isPublic` is stored for later
 * friends sharing and is not a visibility grant. There is no public list route.
 */
export function placeListsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.get('/', validate({ query: paginationQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof paginationQuery> }>(req);
    res.set('Cache-Control', PRIVATE);
    res.json(await listPlaceLists(currentUser(req)._id, query));
  });

  router.post('/', validate({ body: createBody }), async (req, res) => {
    const { body } = getValidated<{ body: z.infer<typeof createBody> }>(req);
    res.set('Cache-Control', PRIVATE);
    res.status(201).json({ list: await createPlaceList(currentUser(req)._id, body) });
  });

  router.post(
    '/:id/places',
    validate({ params: idParams, body: addPlaceBody }),
    async (req, res) => {
      const { params, body } = getValidated<{
        params: z.infer<typeof idParams>;
        body: z.infer<typeof addPlaceBody>;
      }>(req);
      res.set('Cache-Control', PRIVATE);
      const list = await addPlaceToList(currentUser(req)._id, params.id, body.placeId);
      res.json({ list });
    },
  );

  router.delete('/:id/places/:placeId', validate({ params: listPlaceParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof listPlaceParams> }>(req);
    res.set('Cache-Control', PRIVATE);
    const list = await removePlaceFromList(currentUser(req)._id, params.id, params.placeId);
    res.json({ list });
  });

  router.get('/:id', validate({ params: idParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof idParams> }>(req);
    res.set('Cache-Control', PRIVATE);
    res.json({ list: await getPlaceList(currentUser(req)._id, params.id) });
  });

  router.patch('/:id', validate({ params: idParams, body: patchBody }), async (req, res) => {
    const { params, body } = getValidated<{
      params: z.infer<typeof idParams>;
      body: z.infer<typeof patchBody>;
    }>(req);
    res.set('Cache-Control', PRIVATE);
    res.json({ list: await updatePlaceList(currentUser(req)._id, params.id, body) });
  });

  router.delete('/:id', validate({ params: idParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof idParams> }>(req);
    await deletePlaceList(currentUser(req)._id, params.id);
    res.status(204).end();
  });

  return router;
}
