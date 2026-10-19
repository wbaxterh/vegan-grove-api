import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreatorModel } from '../src/models/index.js';
import { ingestItems } from '../src/services/ingest.js';
import {
  bearer,
  createTestContext,
  promoteToAdmin,
  type RegisteredUser,
  registerUser,
  type TestContext,
} from './helpers/app.js';

const KEY = 'test-ingest-key-0123456789abcdef';
const withKey = { 'X-Ingest-Key': KEY };

const creator = (sourceId: string, extra: Record<string, unknown> = {}) => ({
  sourceId,
  name: `Creator ${sourceId}`,
  kind: 'person',
  bio: 'A test creator.',
  topics: ['cooking'],
  country: 'US',
  languages: ['en'],
  website: 'https://example.com',
  veganSource: { url: 'https://en.wikipedia.org/wiki/Test', label: 'Wikipedia' },
  ...extra,
});

describe('creators feature', () => {
  let ctx: TestContext;
  let member: RegisteredUser;
  let admin: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestContext({ INGEST_KEY: KEY, TRUSTED_SOURCES: 'curated,osm' });
  });

  beforeEach(async () => {
    await ctx.reset();
    member = await registerUser(ctx.app);
    admin = await registerUser(ctx.app);
    await promoteToAdmin(admin.id);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('POST /api/ingest/creators', () => {
    it('requires ingest auth', async () => {
      const anon = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .send({ source: 'curated', items: [creator('a')] });
      expect(anon.status).toBe(401);

      const memberReq = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(bearer(member.token))
        .send({ source: 'curated', items: [creator('a')] });
      expect(memberReq.status).toBe(403);
      expect(await CreatorModel.countDocuments()).toBe(0);
    });

    it('accepts creators via ingest key', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({
          source: 'curated',
          items: [
            creator('ed-winters', {
              name: 'Ed Winters',
              alsoKnownAs: ['Earthling Ed'],
              wikidata: 'Q65930940',
              socials: { youtube: 'UCVRrGAcUc7cblUzOhI1KfFg', instagram: 'earthlinged' },
            }),
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ inserted: 1, updated: 0, unchanged: 0, rejected: [] });

      const row = await CreatorModel.findOne({ source: 'curated', sourceId: 'ed-winters' }).lean();
      expect(row).toMatchObject({
        name: 'Ed Winters',
        slug: 'ed-winters',
        status: 'draft',
        alsoKnownAs: ['Earthling Ed'],
        externalIds: { wikidata: 'Q65930940' },
        socials: { youtube: 'UCVRrGAcUc7cblUzOhI1KfFg', instagram: 'earthlinged' },
      });
    });

    it('always lands as draft regardless of trusted source', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({ source: 'curated', items: [creator('trusted-test')] });
      expect(res.status).toBe(200);

      const row = await CreatorModel.findOne({ sourceId: 'trusted-test' }).lean();
      expect(row?.status).toBe('draft');
    });

    it('allows members field for duo/team creators', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({
          source: 'curated',
          items: [
            creator('bosh', {
              name: 'BOSH!',
              kind: 'duo',
              members: ['Henry Firth', 'Ian Theasby'],
            }),
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.inserted).toBe(1);
      expect(res.body.rejected).toHaveLength(0);

      const row = await CreatorModel.findOne({ sourceId: 'bosh' }).lean();
      expect(row?.kind).toBe('duo');
      expect(row?.members).toEqual(['Henry Firth', 'Ian Theasby']);
    });

    it('rejects personal data fields except members', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({
          source: 'curated',
          items: [
            creator('bad-email', { email: 'test@example.com' }),
            creator('bad-phone', { phone: '555-0100' }),
          ],
        });
      expect(res.status).toBe(207);
      expect(res.body.inserted).toBe(0);
      expect(res.body.rejected).toHaveLength(2);
      expect(res.body.rejected[0].errors).toEqual(['email: personal data is not accepted']);
      expect(res.body.rejected[1].errors).toEqual(['phone: personal data is not accepted']);
    });

    it('upserts by source+sourceId without creating duplicates', async () => {
      const first = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({ source: 'curated', items: [creator('upsert-test', { bio: 'Original bio.' })] });
      expect(first.body).toMatchObject({ inserted: 1, updated: 0 });

      const second = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({ source: 'curated', items: [creator('upsert-test', { bio: 'Updated bio.' })] });
      expect(second.body).toMatchObject({ inserted: 0, updated: 1 });
      expect(await CreatorModel.countDocuments({ sourceId: 'upsert-test' })).toBe(1);

      const row = await CreatorModel.findOne({ sourceId: 'upsert-test' }).lean();
      expect(row?.bio).toBe('Updated bio.');
    });

    it('never overwrites admin-edited bio', async () => {
      await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({ source: 'curated', items: [creator('admin-edit', { bio: 'Original.' })] });

      await CreatorModel.updateOne(
        { sourceId: 'admin-edit' },
        { $set: { bio: 'Admin wrote this.', adminEdited: ['bio'] } },
      );

      const res = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({ source: 'curated', items: [creator('admin-edit', { bio: 'Bot update.' })] });
      expect(res.status).toBe(200);
      expect(res.body.rejected).toHaveLength(0);

      const row = await CreatorModel.findOne({ sourceId: 'admin-edit' }).lean();
      expect(row?.bio).toBe('Admin wrote this.');
    });

    it('validates country as ISO 3166-1 alpha-2', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/creators')
        .set(withKey)
        .send({
          source: 'curated',
          items: [creator('bad-country', { country: 'USA' })],
        });
      expect(res.status).toBe(207);
      expect(res.body.rejected[0].errors.join(' ')).toMatch(/country/);
    });
  });

  describe('GET /api/creators', () => {
    beforeEach(async () => {
      await CreatorModel.create([
        {
          name: 'Alpha Creator',
          slug: 'alpha-creator',
          status: 'published',
          kind: 'person',
          bio: 'First in alphabet.',
          topics: ['cooking'],
          languages: ['en'],
          country: 'US',
        },
        {
          name: 'Beta Creator',
          slug: 'beta-creator',
          status: 'published',
          kind: 'person',
          bio: 'Second in alphabet.',
          topics: ['nutrition', 'fitness'],
          languages: ['en', 'de'],
          country: 'DE',
        },
        {
          name: 'Gamma Creator',
          slug: 'gamma-creator',
          status: 'draft',
          kind: 'person',
          bio: 'Not published yet.',
          topics: ['cooking'],
          languages: ['en'],
        },
        {
          name: 'Delta Creator',
          slug: 'delta-creator',
          status: 'retired',
          kind: 'person',
          bio: 'Retired entry.',
          topics: ['cooking'],
          languages: ['en'],
        },
      ]);
    });

    it('lists only published creators in alphabetical order', async () => {
      const res = await supertest(ctx.app).get('/api/creators');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('public');
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual([
        'Alpha Creator',
        'Beta Creator',
      ]);
    });

    it('filters by topic', async () => {
      const res = await supertest(ctx.app).get('/api/creators').query({ topic: 'fitness' });
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['Beta Creator']);
    });

    it('filters by language', async () => {
      const res = await supertest(ctx.app).get('/api/creators').query({ lang: 'de' });
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['Beta Creator']);
    });

    it('filters by country', async () => {
      const res = await supertest(ctx.app).get('/api/creators').query({ country: 'US' });
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['Alpha Creator']);
    });

    it('searches by name and bio', async () => {
      const res = await supertest(ctx.app).get('/api/creators').query({ q: 'Beta' });
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['Beta Creator']);
    });

    it('supports cursor pagination', async () => {
      const first = await supertest(ctx.app).get('/api/creators').query({ limit: 1 });
      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await supertest(ctx.app)
        .get('/api/creators')
        .query({ limit: 1, cursor: first.body.nextCursor });
      expect(second.body.items).toHaveLength(1);
      expect(first.body.items[0].name).not.toBe(second.body.items[0].name);
    });
  });

  describe('GET /api/creators/:slug', () => {
    beforeEach(async () => {
      await CreatorModel.create([
        {
          name: 'Published Creator',
          slug: 'published-creator',
          status: 'published',
          kind: 'person',
          bio: 'A published creator.',
          topics: ['cooking'],
          languages: ['en'],
          website: 'https://example.com',
          socials: { youtube: 'channel123' },
          veganSource: { url: 'https://example.com/source', label: 'Official site' },
        },
        {
          name: 'Draft Creator',
          slug: 'draft-creator',
          status: 'draft',
          kind: 'person',
        },
        {
          name: 'Retired Creator',
          slug: 'retired-creator',
          status: 'retired',
          kind: 'person',
        },
      ]);
    });

    it('returns published creator with full shape', async () => {
      const res = await supertest(ctx.app).get('/api/creators/published-creator');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('public');
      expect(res.body.creator).toMatchObject({
        name: 'Published Creator',
        slug: 'published-creator',
        kind: 'person',
        bio: 'A published creator.',
        topics: ['cooking'],
        languages: ['en'],
        website: 'https://example.com',
        socials: { youtube: 'channel123' },
        veganSource: { url: 'https://example.com/source', label: 'Official site' },
      });
    });

    it('returns 404 for draft creator', async () => {
      const res = await supertest(ctx.app).get('/api/creators/draft-creator');
      expect(res.status).toBe(404);
    });

    it('returns 410 for retired creator', async () => {
      const res = await supertest(ctx.app).get('/api/creators/retired-creator');
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('creator_retired');
    });

    it('returns 404 for non-existent creator', async () => {
      const res = await supertest(ctx.app).get('/api/creators/no-such-creator');
      expect(res.status).toBe(404);
    });
  });

  describe('admin routes', () => {
    it('requires admin auth', async () => {
      expect((await supertest(ctx.app).get('/api/admin/creators')).status).toBe(401);
      expect(
        (await supertest(ctx.app).get('/api/admin/creators').set(bearer(member.token))).status,
      ).toBe(403);
    });

    it('lists all creators including draft and retired', async () => {
      await CreatorModel.create([
        { name: 'Pub', slug: 'pub', status: 'published', kind: 'person' },
        { name: 'Draft', slug: 'draft', status: 'draft', kind: 'person' },
        { name: 'Retired', slug: 'retired', status: 'retired', kind: 'person' },
      ]);

      const res = await supertest(ctx.app).get('/api/admin/creators').set(bearer(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
    });

    it('filters by status', async () => {
      await CreatorModel.create([
        { name: 'Pub', slug: 'pub', status: 'published', kind: 'person' },
        { name: 'Draft', slug: 'draft', status: 'draft', kind: 'person' },
      ]);

      const res = await supertest(ctx.app)
        .get('/api/admin/creators')
        .set(bearer(admin.token))
        .query({ status: 'draft' });
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe('Draft');
    });

    it('creates a creator', async () => {
      const res = await supertest(ctx.app)
        .post('/api/admin/creators')
        .set(bearer(admin.token))
        .send({
          name: 'New Creator',
          bio: 'Created by admin.',
          topics: ['outreach'],
          country: 'GB',
          languages: ['en'],
        });
      expect(res.status).toBe(201);
      expect(res.body.creator).toMatchObject({
        name: 'New Creator',
        slug: 'new-creator',
        status: 'draft',
        adminEdited: expect.arrayContaining(['name', 'bio', 'topics']),
      });
    });

    it('updates and locks fields against ingest', async () => {
      const created = await CreatorModel.create({
        name: 'Test',
        slug: 'test',
        status: 'draft',
        kind: 'person',
        bio: 'Original.',
        source: 'curated',
        sourceId: 'test-admin',
      });

      const updated = await supertest(ctx.app)
        .patch(`/api/admin/creators/${created._id}`)
        .set(bearer(admin.token))
        .send({ bio: 'Admin edited.', status: 'published' });
      expect(updated.status).toBe(200);
      expect(updated.body.creator).toMatchObject({
        bio: 'Admin edited.',
        status: 'published',
        adminEdited: expect.arrayContaining(['bio', 'status']),
      });

      const result = await ingestItems(
        'creators',
        'curated',
        [{ sourceId: 'test-admin', name: 'Test', bio: 'Bot tried to change.', kind: 'person' }],
        { trusted: true },
      );
      expect(result.unchanged).toBe(1);

      const row = await CreatorModel.findById(created._id).lean();
      expect(row?.bio).toBe('Admin edited.');
    });

    it('publishes a draft creator', async () => {
      const created = await CreatorModel.create({
        name: 'Unpub',
        slug: 'unpub',
        status: 'draft',
        kind: 'person',
      });

      const res = await supertest(ctx.app)
        .patch(`/api/admin/creators/${created._id}`)
        .set(bearer(admin.token))
        .send({ status: 'published', reviewedAt: new Date().toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.creator.status).toBe('published');
      expect(res.body.creator.reviewedAt).toBeTruthy();
    });

    it('retires a creator', async () => {
      const created = await CreatorModel.create({
        name: 'ToRetire',
        slug: 'to-retire',
        status: 'published',
        kind: 'person',
      });

      const res = await supertest(ctx.app)
        .patch(`/api/admin/creators/${created._id}`)
        .set(bearer(admin.token))
        .send({ status: 'retired' });
      expect(res.status).toBe(200);
      expect(res.body.creator.status).toBe('retired');

      const publicRes = await supertest(ctx.app).get('/api/creators/to-retire');
      expect(publicRes.status).toBe(410);
    });

    it('deletes a creator', async () => {
      const created = await CreatorModel.create({
        name: 'ToDelete',
        slug: 'to-delete',
        status: 'draft',
        kind: 'person',
      });

      const res = await supertest(ctx.app)
        .delete(`/api/admin/creators/${created._id}`)
        .set(bearer(admin.token));
      expect(res.status).toBe(204);
      expect(await CreatorModel.countDocuments({ _id: created._id })).toBe(0);
    });
  });
});
