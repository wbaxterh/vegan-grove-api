import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound, notImplemented } from '../lib/errors.js';
import {
  idParams,
  objectIdSchema,
  paginationQuery,
  pointInput,
  slugParams,
} from '../lib/schemas.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { getValidated, validate } from '../middleware/validate.js';
import {
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  HOME_AREAS,
  HOST_TYPES,
  RSVP_STATUSES,
} from '../models/index.js';
import { getVisibleEventBySlug, listVisibleEvents, viewerFor } from '../services/events.js';

const listQuery = paginationQuery.extend({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  area: z.enum(HOME_AREAS).optional(),
  groveId: objectIdSchema.optional(),
  type: z.enum(EVENT_TYPES).optional(),
});

const eventBody = z
  .object({
    title: z.string().trim().min(1).max(140),
    type: z.enum(EVENT_TYPES),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    location: pointInput,
    placeId: objectIdSchema.optional(),
    venueName: z.string().trim().max(120).default(''),
    address: z.string().trim().max(240).default(''),
    detailsAfterRsvp: z.boolean().default(false),
    hostType: z.enum(HOST_TYPES),
    hostId: objectIdSchema,
    description: z.string().trim().max(4000).default(''),
    coverKey: z.string().max(200).optional(),
    visibility: z.enum(EVENT_VISIBILITIES).default('public'),
  })
  .strict();

const patchBody = eventBody.partial().extend({
  status: z.enum(['draft', 'published', 'cancelled']).optional(),
});

const rsvpBody = z.object({ status: z.enum(RSVP_STATUSES).default('going') }).strict();

/**
 * Events. Reads are public but filtered per viewer (see services/events.ts);
 * a token is optional and, when present, must be valid.
 */
export function eventsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  const maybeAuth = optionalAuth(deps);

  router.get('/', maybeAuth, validate({ query: listQuery }), async (req, res) => {
    const { query } = getValidated<{ query: z.infer<typeof listQuery> }>(req);
    const viewer = await viewerFor(req.auth?.user);
    res.json(
      await listVisibleEvents(
        {
          ...query,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
        },
        viewer,
      ),
    );
  });

  router.get('/:slug', maybeAuth, validate({ params: slugParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof slugParams> }>(req);
    const event = await getVisibleEventBySlug(params.slug, await viewerFor(req.auth?.user));
    if (!event) throw notFound('Event not found.');
    res.json({ event });
  });

  // TODO(m2): writes need grove organizer or org admin; attendees are visible
  // to the organizer only, counts to everyone.
  router.post('/', auth, validate({ body: eventBody }), notImplemented);
  router.patch('/:id', auth, validate({ params: idParams, body: patchBody }), notImplemented);
  router.post('/:id/rsvp', auth, validate({ params: idParams, body: rsvpBody }), notImplemented);
  router.delete('/:id/rsvp', auth, validate({ params: idParams }), notImplemented);
  router.get(
    '/:id/attendees',
    auth,
    validate({ params: idParams, query: paginationQuery }),
    notImplemented,
  );

  return router;
}
