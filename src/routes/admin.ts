import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound, notImplemented } from '../lib/errors.js';
import { idParams, paginationQuery } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { getValidated, validate } from '../middleware/validate.js';
import {
  GUIDE_CATEGORIES,
  MEDIA_KINDS,
  PUBLISH_STATUSES,
  REPORT_STATUSES,
} from '../models/index.js';
import { listPendingPlaces, setPlaceApproval } from '../services/places.js';

const mediaBody = z
  .object({
    title: z.string().trim().min(1).max(160),
    kind: z.enum(MEDIA_KINDS),
    year: z.number().int().min(1900).max(2100).optional(),
    synopsis: z.string().trim().max(4000).default(''),
    posterKey: z.string().max(200).optional(),
    watchLinks: z
      .array(z.object({ provider: z.string().trim().min(1).max(60), url: z.url() }))
      .max(20)
      .default([]),
    trailerYoutubeId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{6,20}$/)
      .optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
    featured: z.boolean().default(false),
    status: z.enum(PUBLISH_STATUSES).default('draft'),
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

  // TODO(m2): media and guide CRUD, report queue.
  router.get('/media', validate({ query: paginationQuery }), notImplemented);
  router.post('/media', validate({ body: mediaBody }), notImplemented);
  router.patch(
    '/media/:id',
    validate({ params: idParams, body: mediaBody.partial() }),
    notImplemented,
  );
  router.delete('/media/:id', validate({ params: idParams }), notImplemented);

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
