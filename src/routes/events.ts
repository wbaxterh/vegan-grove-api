import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import {
  idParams,
  objectIdSchema,
  paginationQuery,
  pointInput,
  slugParams,
} from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  HOME_AREAS,
  HOST_TYPES,
  RSVP_STATUSES,
} from '../models/index.js';

const listQuery = paginationQuery.extend({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  area: z.enum(HOME_AREAS).optional(),
  groveId: objectIdSchema.optional(),
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

// TODO(m2): events. Listing is public; writes need grove organizer or org admin;
// attendees are visible to the organizer only, counts to everyone.
export function eventsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);

  router.get('/', validate({ query: listQuery }), notImplemented);
  router.get('/:slug', validate({ params: slugParams }), notImplemented);
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
