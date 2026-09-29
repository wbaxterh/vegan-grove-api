import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Place, PlaceModel } from '../src/models/index.js';
import { MAP_PINS_LIMIT } from '../src/services/places.js';
import {
  bearer,
  createTestContext,
  promoteToAdmin,
  registerUser,
  type TestContext,
} from './helpers/app.js';

type SeedPlace = Pick<
  Place,
  'name' | 'slug' | 'type' | 'veganLevel' | 'approvalStatus' | 'source'
> & {
  location: { type: 'Point'; coordinates: [number, number] };
  chain?: boolean;
  reviewCount?: number;
};

// Long Beach bounding box; the Ventura point sits well outside it.
const LB_BBOX = '-118.25,33.72,-118.05,33.88';
const seed = (
  slug: string,
  approvalStatus: Place['approvalStatus'],
  coords: [number, number],
  extra: Partial<Pick<SeedPlace, 'type' | 'veganLevel' | 'chain' | 'reviewCount' | 'name'>> = {},
): SeedPlace => ({
  name: slug.replace(/-/g, ' '),
  slug,
  type: 'restaurant',
  veganLevel: 'full',
  location: { type: 'Point', coordinates: coords },
  approvalStatus,
  source: 'curated',
  ...extra,
});

const slugs = (res: supertest.Response) => res.body.items.map((p: { slug: string }) => p.slug);

describe('/api/places', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
    await PlaceModel.create([
      seed('approved-lb-one', 'approved', [-118.19, 33.77], { reviewCount: 2 }),
      seed('approved-lb-two', 'approved', [-118.2, 33.78], { reviewCount: 5 }),
      seed('approved-lb-cafe', 'approved', [-118.15, 33.8], {
        type: 'cafe',
        veganLevel: 'options',
      }),
      seed('approved-lb-chain', 'approved', [-118.16, 33.79], { chain: true, reviewCount: 9 }),
      seed('approved-lb-garden', 'approved', [-118.14, 33.81], { type: 'garden' }),
      seed('pending-lb', 'pending', [-118.18, 33.78]),
      seed('rejected-lb', 'rejected', [-118.17, 33.79]),
      seed('approved-ventura', 'approved', [-119.29, 34.28]),
    ]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('GET /api/places', () => {
    it('defaults to fully vegan, non-chain, approved places inside the bbox', async () => {
      const res = await supertest(ctx.app).get('/api/places').query({ bbox: LB_BBOX });
      expect(res.status).toBe(200);
      expect(slugs(res)).toEqual(['approved-lb-two', 'approved-lb-one', 'approved-lb-garden']);
      expect(res.body.nextCursor).toBeNull();
      for (const item of res.body.items) {
        expect(item.submittedBy).toBeUndefined();
        expect(item.adminEdited).toBeUndefined();
        expect(item).toMatchObject({ chain: false, phone: null, postcode: null, sourceId: null });
      }
    });

    it('ranks full first, then independents, then reviews, then name', async () => {
      const res = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, veganLevel: 'all', includeChains: 'true' });
      expect(slugs(res)).toEqual([
        'approved-lb-two',
        'approved-lb-one',
        'approved-lb-garden',
        'approved-lb-chain',
        'approved-lb-cafe',
      ]);
    });

    it('requires a well-formed bbox', async () => {
      const missing = await supertest(ctx.app).get('/api/places');
      const bad = await supertest(ctx.app).get('/api/places').query({ bbox: '1,2,3' });
      const inverted = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: '-118,34,-119,33' });
      expect(missing.status).toBe(400);
      expect(bad.status).toBe(400);
      expect(inverted.status).toBe(400);
      expect(missing.body.error.code).toBe('validation_error');
    });

    it('filters by vegan level, types, chains and name', async () => {
      const options = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, veganLevel: 'options' });
      expect(slugs(options)).toEqual(['approved-lb-cafe']);

      const types = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, veganLevel: 'all', types: 'cafe,garden' });
      expect(slugs(types)).toEqual(['approved-lb-garden', 'approved-lb-cafe']);

      const single = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, veganLevel: 'all', type: 'cafe' });
      expect(slugs(single)).toEqual(['approved-lb-cafe']);

      const badType = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, types: 'cafe,castle' });
      expect(badType.status).toBe(400);

      const chains = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, includeChains: 'true' });
      expect(slugs(chains)).toContain('approved-lb-chain');

      const byName = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, q: 'LB ONE' });
      expect(slugs(byName)).toEqual(['approved-lb-one']);
    });

    it('paginates with an opaque cursor in ranking order', async () => {
      const first = await supertest(ctx.app).get('/api/places').query({ bbox: LB_BBOX, limit: 1 });
      expect(slugs(first)).toEqual(['approved-lb-two']);
      expect(typeof first.body.nextCursor).toBe('string');
      expect(first.body.nextCursor).not.toContain('approved');

      const second = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, limit: 1, cursor: first.body.nextCursor });
      expect(slugs(second)).toEqual(['approved-lb-one']);

      const third = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, limit: 1, cursor: second.body.nextCursor });
      expect(slugs(third)).toEqual(['approved-lb-garden']);
      expect(third.body.nextCursor).toBeNull();

      const garbage = await supertest(ctx.app)
        .get('/api/places')
        .query({ bbox: LB_BBOX, cursor: 'not-a-cursor' });
      expect(garbage.status).toBe(400);
      expect(garbage.body.error.code).toBe('invalid_cursor');
    });
  });

  describe('GET /api/places/map-pins', () => {
    it('returns slim pins with the same defaults and no cursor', async () => {
      const res = await supertest(ctx.app).get('/api/places/map-pins').query({ bbox: LB_BBOX });
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(false);
      expect(res.body.nextCursor).toBeUndefined();
      expect(slugs(res)).toEqual(['approved-lb-two', 'approved-lb-one', 'approved-lb-garden']);
      expect(Object.keys(res.body.items[0]).sort()).toEqual([
        'chain',
        'id',
        'location',
        'name',
        'slug',
        'type',
        'veganLevel',
      ]);

      const all = await supertest(ctx.app)
        .get('/api/places/map-pins')
        .query({ bbox: LB_BBOX, veganLevel: 'all', includeChains: 'true', types: 'restaurant' });
      expect(slugs(all)).toEqual(['approved-lb-two', 'approved-lb-one', 'approved-lb-chain']);

      const missing = await supertest(ctx.app).get('/api/places/map-pins');
      expect(missing.status).toBe(400);
    });

    it(`caps at ${MAP_PINS_LIMIT} pins and says so`, async () => {
      await PlaceModel.insertMany(
        Array.from({ length: MAP_PINS_LIMIT }, (_, i) =>
          seed(`bulk-${i}`, 'approved', [
            -118.2 + (i % 100) * 0.001,
            33.75 + Math.floor(i / 100) * 0.001,
          ]),
        ),
      );
      const res = await supertest(ctx.app).get('/api/places/map-pins').query({ bbox: LB_BBOX });
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(MAP_PINS_LIMIT);
      expect(res.body.truncated).toBe(true);
      // Ranking decides who gets drawn: the reviewed independents come first.
      expect(slugs(res).slice(0, 2)).toEqual(['approved-lb-two', 'approved-lb-one']);
    });
  });

  describe('GET /api/places/:slug', () => {
    it('returns an approved place and hides everything else', async () => {
      const ok = await supertest(ctx.app).get('/api/places/approved-lb-one');
      expect(ok.status).toBe(200);
      expect(ok.body.place).toMatchObject({
        slug: 'approved-lb-one',
        location: { lng: -118.19, lat: 33.77 },
        chain: false,
      });

      const pending = await supertest(ctx.app).get('/api/places/pending-lb');
      expect(pending.status).toBe(404);
    });
  });

  describe('POST /api/places', () => {
    const body = {
      name: 'Seed Kitchen',
      type: 'restaurant',
      veganLevel: 'full',
      location: { lng: -118.16, lat: 33.76 },
      city: 'Long Beach',
      area: 'long_beach',
      tags: ['lunch'],
    };

    it('requires a session', async () => {
      const res = await supertest(ctx.app).post('/api/places').send(body);
      expect(res.status).toBe(401);
    });

    it('creates a pending submission attributed to the session user, not the body', async () => {
      const { token, id } = await registerUser(ctx.app);
      const res = await supertest(ctx.app)
        .post('/api/places')
        .set(bearer(token))
        .send({ ...body, submittedBy: '000000000000000000000000' });
      expect(res.status).toBe(400); // strict body: unknown field rejected

      const created = await supertest(ctx.app).post('/api/places').set(bearer(token)).send(body);
      expect(created.status).toBe(201);
      expect(created.body.place).toMatchObject({
        slug: 'seed-kitchen',
        approvalStatus: 'pending',
        source: 'user',
      });
      expect(created.body.place.submittedBy).toBeUndefined();

      const stored = await PlaceModel.findOne({ slug: 'seed-kitchen' });
      expect(stored?.submittedBy?.toHexString()).toBe(id);

      const listed = await supertest(ctx.app).get('/api/places').query({ bbox: LB_BBOX });
      expect(slugs(listed)).not.toContain('seed-kitchen');
    });

    it('gives a second place with the same name a distinct slug', async () => {
      const { token } = await registerUser(ctx.app);
      const a = await supertest(ctx.app).post('/api/places').set(bearer(token)).send(body);
      const b = await supertest(ctx.app).post('/api/places').set(bearer(token)).send(body);
      expect(a.body.place.slug).toBe('seed-kitchen');
      expect(b.body.place.slug).toMatch(/^seed-kitchen-[a-f0-9]{6}$/);
    });
  });

  describe('admin approval', () => {
    it('refuses non-admins even with a valid session', async () => {
      const { token } = await registerUser(ctx.app);
      const pending = await PlaceModel.findOne({ slug: 'pending-lb' });
      const res = await supertest(ctx.app)
        .put(`/api/admin/places/${pending?._id}/approve`)
        .set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
      const list = await supertest(ctx.app).get('/api/admin/places/pending').set(bearer(token));
      expect(list.status).toBe(403);
    });

    it('lets an admin list, approve and reject, and records the decision as an admin edit', async () => {
      const { token, id } = await registerUser(ctx.app);
      await promoteToAdmin(id);

      const queue = await supertest(ctx.app).get('/api/admin/places/pending').set(bearer(token));
      expect(queue.status).toBe(200);
      expect(slugs(queue)).toEqual(['pending-lb']);

      const pending = await PlaceModel.findOne({ slug: 'pending-lb' });
      const approved = await supertest(ctx.app)
        .put(`/api/admin/places/${pending?._id}/approve`)
        .set(bearer(token));
      expect(approved.status).toBe(200);
      expect(approved.body.place.approvalStatus).toBe('approved');

      const listed = await supertest(ctx.app).get('/api/places').query({ bbox: LB_BBOX });
      expect(slugs(listed)).toContain('pending-lb');

      const rejected = await supertest(ctx.app)
        .put(`/api/admin/places/${pending?._id}/reject`)
        .set(bearer(token));
      expect(rejected.body.place.approvalStatus).toBe('rejected');
      const stored = await PlaceModel.findById(pending?._id).lean();
      expect(stored?.adminEdited).toEqual(['approvalStatus']);

      const missing = await supertest(ctx.app)
        .put('/api/admin/places/000000000000000000000000/approve')
        .set(bearer(token));
      expect(missing.status).toBe(404);
    });
  });
});
