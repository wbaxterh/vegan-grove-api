import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EventModel,
  EventRsvpModel,
  FriendshipModel,
  GroveMemberModel,
  GroveModel,
  OrganizationModel,
  Types,
} from '../src/models/index.js';
import {
  bearer,
  createTestContext,
  type RegisteredUser,
  registerUser,
  type TestContext,
} from './helpers/app.js';

const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.now() + days * DAY);
const slugs = (res: supertest.Response) => res.body.items.map((e: { slug: string }) => e.slug);

describe('/api/events', () => {
  let ctx: TestContext;
  let orgId: Types.ObjectId;
  let groveId: Types.ObjectId;
  let creator: RegisteredUser;
  let friend: RegisteredUser;
  let stranger: RegisteredUser;

  const seed = (
    slug: string,
    days: number,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    title: slug.replace(/-/g, ' '),
    slug,
    type: 'outreach',
    startsAt: at(days),
    endsAt: new Date(at(days).getTime() + 2 * 60 * 60 * 1000),
    location: { type: 'Point', coordinates: [-118.19, 33.77] },
    area: 'long_beach',
    venueName: 'Shoreline',
    address: '1 Pine Ave',
    hostType: 'organization',
    hostId: orgId,
    hostModel: 'Organization',
    visibility: 'public',
    status: 'published',
    ...extra,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    creator = await registerUser(ctx.app);
    friend = await registerUser(ctx.app);
    stranger = await registerUser(ctx.app);
  });

  beforeEach(async () => {
    await ctx.reset();
    // reset() wipes users too; re-create the three members with the same handles.
    creator = await registerUser(ctx.app, { handle: 'creator_1', email: 'c1@example.org' });
    friend = await registerUser(ctx.app, { handle: 'friend_1', email: 'f1@example.org' });
    stranger = await registerUser(ctx.app, { handle: 'stranger_1', email: 's1@example.org' });
    const [a, b] = [new Types.ObjectId(creator.id), new Types.ObjectId(friend.id)].sort((x, y) =>
      x.toHexString() < y.toHexString() ? -1 : 1,
    );
    await FriendshipModel.create({ userA: a, userB: b, status: 'accepted', requestedBy: a });

    const org = await OrganizationModel.create({
      name: 'Animal Place',
      slug: 'animal-place',
      type: 'sanctuary',
      verified: true,
      adminUserIds: [new Types.ObjectId(creator.id)],
    });
    orgId = org._id;
    const grove = await GroveModel.create({
      name: 'Long Beach Grove',
      slug: 'long-beach',
      area: 'long_beach',
    });
    groveId = grove._id;
    await GroveMemberModel.create({ groveId, userId: new Types.ObjectId(friend.id) });

    await EventModel.create([
      seed('public-soon', 1),
      seed('public-later', 10, { type: 'vigil', area: 'orange_county' }),
      seed('public-past', -5),
      seed('public-draft', 3, { status: 'draft' }),
      seed('public-pending', 3, { status: 'pending' }),
      seed('public-cancelled', 4, { status: 'cancelled' }),
      seed('grove-only', 2, {
        visibility: 'grove',
        hostType: 'grove',
        hostId: groveId,
        hostModel: 'Grove',
      }),
      seed('friends-only', 5, { visibility: 'friends', createdBy: new Types.ObjectId(creator.id) }),
      seed('secret-address', 6, { detailsAfterRsvp: true }),
    ]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('GET /api/events', () => {
    it('lists published public events from now on, soonest first, for anonymous callers', async () => {
      const res = await supertest(ctx.app).get('/api/events');
      expect(res.status).toBe(200);
      expect(slugs(res)).toEqual(['public-soon', 'secret-address', 'public-later']);
      expect(res.body.nextCursor).toBeNull();
      const first = res.body.items[0];
      expect(first.host).toEqual({
        type: 'organization',
        id: orgId.toHexString(),
        name: 'Animal Place',
        slug: 'animal-place',
        verified: true,
      });
      expect(first.createdBy).toBeUndefined();
      expect(first.location).toEqual({ lng: -118.19, lat: 33.77 });
    });

    it('filters by window, area, type and grove', async () => {
      const past = await supertest(ctx.app)
        .get('/api/events')
        .query({ from: at(-10).toISOString(), to: at(0).toISOString() });
      expect(slugs(past)).toEqual(['public-past']);

      const area = await supertest(ctx.app).get('/api/events').query({ area: 'orange_county' });
      expect(slugs(area)).toEqual(['public-later']);

      const type = await supertest(ctx.app).get('/api/events').query({ type: 'vigil' });
      expect(slugs(type)).toEqual(['public-later']);

      const grove = await supertest(ctx.app)
        .get('/api/events')
        .query({ groveId: groveId.toHexString() });
      expect(slugs(grove)).toEqual([]);

      const badDate = await supertest(ctx.app).get('/api/events').query({ from: 'yesterday' });
      expect(badDate.status).toBe(400);
    });

    it('shows grove events to members and friends-only events to friends', async () => {
      const asFriend = await supertest(ctx.app).get('/api/events').set(bearer(friend.token));
      expect(slugs(asFriend)).toEqual([
        'public-soon',
        'grove-only',
        'friends-only',
        'secret-address',
        'public-later',
      ]);

      const asStranger = await supertest(ctx.app).get('/api/events').set(bearer(stranger.token));
      expect(slugs(asStranger)).toEqual(['public-soon', 'secret-address', 'public-later']);

      const asCreator = await supertest(ctx.app).get('/api/events').set(bearer(creator.token));
      expect(slugs(asCreator)).toContain('friends-only');
      expect(slugs(asCreator)).not.toContain('grove-only');

      const byGrove = await supertest(ctx.app)
        .get('/api/events')
        .set(bearer(friend.token))
        .query({ groveId: groveId.toHexString() });
      expect(slugs(byGrove)).toEqual(['grove-only']);
      expect(byGrove.body.items[0].host).toEqual({
        type: 'grove',
        id: groveId.toHexString(),
        name: 'Long Beach Grove',
        slug: 'long-beach',
      });

      const expired = await supertest(ctx.app).get('/api/events').set(bearer('not-a-token'));
      expect(expired.status).toBe(401);
    });

    it('hides the address until the viewer has an RSVP', async () => {
      const anon = await supertest(ctx.app).get('/api/events');
      const hidden = anon.body.items.find((e: { slug: string }) => e.slug === 'secret-address');
      expect(hidden).toMatchObject({ address: null, location: null, venueName: 'Shoreline' });

      const event = await EventModel.findOne({ slug: 'secret-address' });
      await EventRsvpModel.create({ eventId: event?._id, userId: new Types.ObjectId(stranger.id) });
      const res = await supertest(ctx.app).get('/api/events').set(bearer(stranger.token));
      const shown = res.body.items.find((e: { slug: string }) => e.slug === 'secret-address');
      expect(shown).toMatchObject({
        address: '1 Pine Ave',
        location: { lng: -118.19, lat: 33.77 },
      });
    });

    it('paginates by start time with an opaque cursor', async () => {
      const first = await supertest(ctx.app).get('/api/events').query({ limit: 2 });
      expect(slugs(first)).toEqual(['public-soon', 'secret-address']);
      const second = await supertest(ctx.app)
        .get('/api/events')
        .query({ limit: 2, cursor: first.body.nextCursor });
      expect(slugs(second)).toEqual(['public-later']);
      expect(second.body.nextCursor).toBeNull();
    });
  });

  describe('GET /api/events/:slug', () => {
    it('returns a visible event with its host and 404s everything else', async () => {
      const ok = await supertest(ctx.app).get('/api/events/public-soon');
      expect(ok.status).toBe(200);
      expect(ok.body.event).toMatchObject({
        slug: 'public-soon',
        status: 'published',
        host: { type: 'organization', slug: 'animal-place' },
      });

      const cancelled = await supertest(ctx.app).get('/api/events/public-cancelled');
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.event.status).toBe('cancelled');

      for (const slug of ['public-draft', 'public-pending', 'grove-only', 'friends-only', 'nope']) {
        const res = await supertest(ctx.app).get(`/api/events/${slug}`);
        expect(res.status, slug).toBe(404);
        expect(res.body.error.code).toBe('not_found');
      }

      const member = await supertest(ctx.app)
        .get('/api/events/grove-only')
        .set(bearer(friend.token));
      expect(member.status).toBe(200);
      const outsider = await supertest(ctx.app)
        .get('/api/events/grove-only')
        .set(bearer(stranger.token));
      expect(outsider.status).toBe(404);
    });
  });

  it('keeps the write routes as validated stubs', async () => {
    const res = await supertest(ctx.app)
      .post('/api/events')
      .set(bearer(creator.token))
      .send({ title: 'x' });
    expect(res.status).toBe(400);
  });
});
