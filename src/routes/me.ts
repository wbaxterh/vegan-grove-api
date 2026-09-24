import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notFound, notImplemented } from '../lib/errors.js';
import { handleSchema, idParams } from '../lib/schemas.js';
import { currentSession, currentUser, requireAuth } from '../middleware/auth.js';
import { getValidated, validate } from '../middleware/validate.js';
import { HOME_AREAS } from '../models/index.js';
import { assertHandleAvailable, deleteAccount, toPrivateUser } from '../services/auth.js';
import { listSessions, revokeSession } from '../services/sessions.js';

// `.strict()` so email, role and providers cannot be smuggled in through PATCH.
const patchMeBody = z
  .object({
    handle: handleSchema.optional(),
    homeArea: z.enum(HOME_AREAS).optional(),
    avatarKey: z.string().max(200).nullable().optional(),
    discoverable: z.boolean().optional(),
    publicPostsEnabled: z.boolean().optional(),
    interests: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .strict();

const notificationPreferencesBody = z
  .object({
    eventReminders: z.boolean().optional(),
    friendRequests: z.boolean().optional(),
    messages: z.boolean().optional(),
    quietHours: z
      .object({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.string().min(1).max(64),
      })
      .nullable()
      .optional(),
  })
  .strict();

/** The member's own record, sessions, and the hard-delete door. */
export function meRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.get('/', (req, res) => {
    res.json({ user: toPrivateUser(currentUser(req)) });
  });

  router.patch('/', validate({ body: patchMeBody }), async (req, res) => {
    const user = currentUser(req);
    const { body } = getValidated<{ body: z.infer<typeof patchMeBody> }>(req);

    if (body.handle !== undefined && body.handle !== user.handle) {
      await assertHandleAvailable(body.handle, user._id);
      user.handle = body.handle;
    }
    if (body.homeArea !== undefined) user.homeArea = body.homeArea;
    if (body.avatarKey !== undefined) user.avatarKey = body.avatarKey ?? undefined;
    if (body.discoverable !== undefined) user.discoverable = body.discoverable;
    if (body.publicPostsEnabled !== undefined) user.publicPostsEnabled = body.publicPostsEnabled;
    if (body.interests !== undefined) user.set('interests', body.interests);

    await user.save();
    res.json({ user: toPrivateUser(user) });
  });

  router.delete('/', async (req, res) => {
    await deleteAccount(currentUser(req)._id);
    res.status(204).end();
  });

  router.get('/sessions', async (req, res) => {
    const items = await listSessions(currentUser(req)._id, currentSession(req)._id);
    res.json({ items, nextCursor: null });
  });

  router.delete('/sessions/:id', validate({ params: idParams }), async (req, res) => {
    const { params } = getValidated<{ params: z.infer<typeof idParams> }>(req);
    const removed = await revokeSession(currentUser(req)._id, params.id);
    if (!removed) throw notFound('Session not found.');
    res.status(204).end();
  });

  // TODO(m2): notification preferences read/upsert.
  router.get('/notification-preferences', notImplemented);
  router.put(
    '/notification-preferences',
    validate({ body: notificationPreferencesBody }),
    notImplemented,
  );

  return router;
}
