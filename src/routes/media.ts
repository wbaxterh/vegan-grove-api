import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound } from '../lib/errors.js';
import { idParams, paginationQuery, slugParams } from '../lib/schemas.js';
import { currentUser, optionalAuth, requireAuth } from '../middleware/auth.js';
import { getValidated, validate } from '../middleware/validate.js';
import { MEDIA_KINDS, MEDIA_REACTION_TYPES } from '../models/index.js';
import {
  getCollectionBySlug,
  getMediaBySlug,
  getViewer,
  homeRows,
  listCollections,
  listMedia,
  MEDIA_SORTS,
  relatedMedia,
  setReaction,
  setSaved,
} from '../services/media.js';

const listQuery = paginationQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  q: z.string().trim().min(2).max(80).optional(),
  kind: z.enum(MEDIA_KINDS).optional(),
  tag: z.string().trim().min(1).max(60).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  free: z
    .enum(['1', 'true', '0', 'false'])
    .transform((v) => v === '1' || v === 'true')
    .optional(),
  maxRuntime: z.coerce.number().int().min(1).max(1000).optional(),
  sort: z.enum(MEDIA_SORTS).optional(),
});

const reactionBody = z.object({ type: z.enum(MEDIA_REACTION_TYPES) }).strict();
const reactionParams = idParams.extend({ type: z.enum(MEDIA_REACTION_TYPES) });

/** Public catalogue reads are safe to cache anywhere; anything with a viewer is not. */
const PUBLIC_CACHE = 'public, max-age=300, stale-while-revalidate=3600';

/**
 * The media library (spec section 10). Published titles only; trailers embed
 * on the client through youtube-nocookie.com; the watchlist and reactions are
 * the only member state and are answered to that member alone.
 */
export function mediaRouter(deps: AppDeps): Router {
  const router = Router();
  const read = { cdnOrigin: deps.env.MEDIA_CDN_ORIGIN };

  router.get('/home', async (_req, res) => {
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json(await homeRows(read));
  });

  router.get('/collections', async (_req, res) => {
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ items: await listCollections(read) });
  });

  router.get('/collections/:slug', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const collection = await getCollectionBySlug(params.slug, read);
    if (!collection) throw notFound('Collection not found.');
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ collection });
  });

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json(await listMedia(query, read));
  });

  router.get('/:slug/related', validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const items = await relatedMedia(params.slug, 12, read);
    if (!items) throw notFound('Media item not found.');
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ items });
  });

  router.get('/:slug', optionalAuth(deps), validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const media = await getMediaBySlug(params.slug, read);
    if (!media) throw notFound('Media item not found.');
    if (req.auth) {
      res.set('Cache-Control', 'private, no-store');
      res.json({ media, viewer: await getViewer(media.id, currentUser(req)._id) });
      return;
    }
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ media });
  });

  // Member state. Both are idempotent, so a retried request cannot double count.
  router.post('/:id/save', requireAuth(deps), validate({ params: idParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof idParams> }>(req);
    res.json({ saved: await setSaved(params.id, currentUser(req)._id, true) });
  });

  router.delete(
    '/:id/save',
    requireAuth(deps),
    validate({ params: idParams }),
    async (req, res) => {
      const { params } = getValidated<{ params: z.infer<typeof idParams> }>(req);
      res.json({ saved: await setSaved(params.id, currentUser(req)._id, false) });
    },
  );

  router.post(
    '/:id/reactions',
    requireAuth(deps),
    validate({ params: idParams, body: reactionBody }),
    async (req, res) => {
      const { params, body } = getValidated<{
        params: z.infer<typeof idParams>;
        body: z.infer<typeof reactionBody>;
      }>(req);
      res.json(await setReaction(params.id, currentUser(req)._id, body.type, true));
    },
  );

  router.delete(
    '/:id/reactions/:type',
    requireAuth(deps),
    validate({ params: reactionParams }),
    async (req, res) => {
      const { params } = getValidated<{ params: z.infer<typeof reactionParams> }>(req);
      res.json(await setReaction(params.id, currentUser(req)._id, params.type, false));
    },
  );

  return router;
}
