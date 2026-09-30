import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound, notImplemented } from '../lib/errors.js';
import { idParams, paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { getValidated, validate } from '../middleware/validate.js';
import { GUIDE_CATEGORIES, PUBLISH_STATUSES, REPORT_STATUSES } from '../models/index.js';
import { mediaItemSchema } from '../services/ingest.js';
import {
  adminCreateCollection,
  adminCreateMedia,
  adminDeleteMedia,
  adminListCollections,
  adminListMedia,
  adminUpdateCollection,
  adminUpdateMedia,
} from '../services/media.js';
import { listPendingPlaces, setPlaceApproval } from '../services/places.js';

// The ingest item shape is the editorial shape; admins add what a bot never may.
const mediaBody = mediaItemSchema
  .omit({ sourceId: true, sourceUrl: true })
  .extend({
    featured: z.boolean().optional(),
    status: z.enum(PUBLISH_STATUSES).optional(),
  })
  .strict();

const adminMediaQuery = paginationQuery.extend({
  status: z.enum(PUBLISH_STATUSES).optional(),
  q: z.string().trim().min(2).max(80).optional(),
});

const collectionBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(80)
      .optional(),
    description: z.string().trim().max(500).optional(),
    order: z.number().int().min(0).max(10_000).optional(),
    published: z.boolean().optional(),
    itemIds: z
      .array(z.string().regex(/^[a-f\d]{24}$/))
      .max(200)
      .optional(),
  })
  .strict();

const guideBody = z
  .object({
    title: z.string().trim().min(1).max(160),
    category: z.enum(GUIDE_CATEGORIES),
    body: z.string().min(1).max(200_000),
    status: z.enum(PUBLISH_STATUSES).default('draft'),
  })
  .strict();

const reportPatchBody = z.object({ status: z.enum(REPORT_STATUSES) }).strict();

/**
 * Admin surface. `requireAdmin` runs after `requireAuth`, which loaded the
 * user from the database on this request: the role is never read from a token.
 */
export function adminRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps), requireAdmin);

  router.get('/places/pending', validate({ query: paginationQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof paginationQuery> }>(req);
    res.json(await listPendingPlaces(query));
  });

  for (const decision of ['approve', 'reject'] as const) {
    router.put(`/places/:id/${decision}`, validate({ params: idParams }), async (req, res) => {
      const { params } = getValidated<{ params: z.infer<typeof idParams> }>(req);
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const place = await setPlaceApproval(params.id, status);
      if (!place) throw notFound('Place not found.');
      res.json({ place });
    });
  }

  const read = { cdnOrigin: deps.env.MEDIA_CDN_ORIGIN };

  // Media library editorial surface (spec section 10). Every field an admin
  // sets is locked against the next ingest run.
  router.get('/media/collections', async (_req, res) => {
    res.json({ items: await adminListCollections() });
  });
  router.post('/media/collections', validate({ body: collectionBody }), async (req, res) => {
    const { body } = getValidated<{ body: z.infer<typeof collectionBody> }>(req);
    res.status(201).json({ collection: await adminCreateCollection(body) });
  });
  router.patch(
    '/media/collections/:id',
    validate({ params: idParams, body: collectionBody.partial() }),
    async (req, res) => {
      const { params, body } = getValidated<{
        params: z.infer<typeof idParams>;
        body: Partial<z.infer<typeof collectionBody>>;
      }>(req);
      const collection = await adminUpdateCollection(params.id, body);
      if (!collection) throw notFound('Collection not found.');
      res.json({ collection });
    },
  );

  router.get('/media', validate({ query: adminMediaQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof adminMediaQuery> }>(req);
    res.json(await adminListMedia(query, read));
  });
  router.post('/media', validate({ body: mediaBody }), async (req, res) => {
    const { body } = getValidated<{ body: z.infer<typeof mediaBody> }>(req);
    res.status(201).json({ media: await adminCreateMedia(body, read) });
  });
  router.patch(
    '/media/:id',
    validate({ params: idParams, body: mediaBody.partial() }),
    async (req, res) => {
      const { params, body } = getValidated<{
        params: z.infer<typeof idParams>;
        body: Partial<z.infer<typeof mediaBody>>;
      }>(req);
      const media = await adminUpdateMedia(params.id, body, read);
      if (!media) throw notFound('Media item not found.');
      res.json({ media });
    },
  );
  router.delete('/media/:id', validate({ params: idParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof idParams> }>(req);
    if (!(await adminDeleteMedia(params.id))) throw notFound('Media item not found.');
    res.status(204).end();
  });

  // TODO(m2): guide CRUD, report queue.

  router.get('/guides', validate({ query: paginationQuery }), notImplemented);
  router.post('/guides', validate({ body: guideBody }), notImplemented);
  router.patch(
    '/guides/:id',
    validate({ params: idParams, body: guideBody.partial() }),
    notImplemented,
  );
  router.delete('/guides/:id', validate({ params: idParams }), notImplemented);

  router.get('/reports', validate({ query: paginationQuery }), notImplemented);
  router.put('/reports/:id', validate({ params: idParams, body: reportPatchBody }), notImplemented);

  return router;
}
