import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GroveModel,
  GuideModel,
  MediaItemModel,
  OrganizationModel,
  Types,
} from '../src/models/index.js';
import { createTestContext, type TestContext } from './helpers/app.js';

const slugs = (res: supertest.Response) => res.body.items.map((i: { slug: string }) => i.slug);

describe('public catalogue', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await OrganizationModel.create([
      {
        name: 'Zeta Collective',
        slug: 'zeta-collective',
        type: 'org',
        verified: true,
        socials: { instagram: 'zeta' },
        adminUserIds: [new Types.ObjectId()],
      },
      { name: 'Alpha Sanctuary', slug: 'alpha-sanctuary', type: 'sanctuary', verified: false },
      { name: 'Beta Sanctuary', slug: 'beta-sanctuary', type: 'sanctuary', verified: true },
    ]);
    await GroveModel.create([
      { name: 'Long Beach Grove', slug: 'long-beach', area: 'long_beach', memberCount: 3 },
      { name: 'Irvine Grove', slug: 'orange-county', area: 'orange_county' },
    ]);
    await MediaItemModel.create([
      {
        title: 'Old Doc',
        slug: 'old-doc',
        kind: 'documentary',
        year: 2005,
        status: 'published',
        tags: ['classic'],
      },
      { title: 'Draft Film', slug: 'draft-film', kind: 'film', status: 'draft' },
      {
        title: 'Featured Film',
        slug: 'featured-film',
        kind: 'film',
        featured: true,
        status: 'published',
        tags: ['classic'],
      },
      { title: 'New Talk', slug: 'new-talk', kind: 'talk', status: 'published' },
    ]);
    await GuideModel.create([
      {
        title: 'Outreach 101',
        slug: 'outreach-101',
        category: 'outreach',
        summary: 'How to start a conversation.',
        body: '# Outreach\n\nSay hello.',
        sources: [{ title: 'AV', url: 'https://example.org/av' }],
        status: 'published',
      },
      { title: 'Draft', slug: 'draft-guide', category: 'outreach', body: 'x', status: 'draft' },
      {
        title: 'Vegan 101',
        slug: 'vegan-101',
        category: 'vegan101',
        body: 'Eat plants.',
        status: 'published',
      },
    ]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('organizations', () => {
    it('lists verified first, then by name, without admin ids', async () => {
      const res = await supertest(ctx.app).get('/api/organizations');
      expect(res.status).toBe(200);
      expect(slugs(res)).toEqual(['beta-sanctuary', 'zeta-collective', 'alpha-sanctuary']);
      for (const item of res.body.items) expect(item.adminUserIds).toBeUndefined();
      expect(res.body.items[1].socials).toEqual({ instagram: 'zeta' });

      const byType = await supertest(ctx.app)
        .get('/api/organizations')
        .query({ type: 'sanctuary' });
      expect(slugs(byType)).toEqual(['beta-sanctuary', 'alpha-sanctuary']);

      const page = await supertest(ctx.app).get('/api/organizations').query({ limit: 2 });
      const next = await supertest(ctx.app)
        .get('/api/organizations')
        .query({ limit: 2, cursor: page.body.nextCursor });
      expect(slugs(next)).toEqual(['alpha-sanctuary']);
    });

    it('returns one by slug and 404s unknown slugs', async () => {
      const ok = await supertest(ctx.app).get('/api/organizations/zeta-collective');
      expect(ok.status).toBe(200);
      expect(ok.body.organization).toMatchObject({ slug: 'zeta-collective', verified: true });
      expect(ok.body.organization.adminUserIds).toBeUndefined();
      const missing = await supertest(ctx.app).get('/api/organizations/nope');
      expect(missing.status).toBe(404);
    });
  });

  describe('groves', () => {
    it('lists by name with counts only, filters by area, and gets one by slug', async () => {
      const res = await supertest(ctx.app).get('/api/groves');
      expect(slugs(res)).toEqual(['orange-county', 'long-beach']);
      expect(res.body.items[1]).toMatchObject({ memberCount: 3, area: 'long_beach' });
      expect(Object.keys(res.body.items[0]).sort()).toEqual([
        'area',
        'createdAt',
        'description',
        'id',
        'memberCount',
        'name',
        'slug',
      ]);

      const area = await supertest(ctx.app).get('/api/groves').query({ area: 'long_beach' });
      expect(slugs(area)).toEqual(['long-beach']);

      const one = await supertest(ctx.app).get('/api/groves/long-beach');
      expect(one.status).toBe(200);
      expect(one.body.grove.name).toBe('Long Beach Grove');
      expect((await supertest(ctx.app).get('/api/groves/nope')).status).toBe(404);
    });
  });

  describe('media', () => {
    it('lists published items, featured first then newest, with kind and tag filters', async () => {
      const res = await supertest(ctx.app).get('/api/media');
      expect(slugs(res)).toEqual(['featured-film', 'new-talk', 'old-doc']);

      const kind = await supertest(ctx.app).get('/api/media').query({ kind: 'film' });
      expect(slugs(kind)).toEqual(['featured-film']);

      const tag = await supertest(ctx.app).get('/api/media').query({ tag: 'classic' });
      expect(slugs(tag)).toEqual(['featured-film', 'old-doc']);

      const page = await supertest(ctx.app).get('/api/media').query({ limit: 1 });
      const next = await supertest(ctx.app)
        .get('/api/media')
        .query({ limit: 1, cursor: page.body.nextCursor });
      expect(slugs(next)).toEqual(['new-talk']);
    });

    it('gets a published item by slug and hides drafts', async () => {
      const ok = await supertest(ctx.app).get('/api/media/old-doc');
      expect(ok.status).toBe(200);
      expect(ok.body.media).toMatchObject({ slug: 'old-doc', year: 2005, kind: 'documentary' });
      expect((await supertest(ctx.app).get('/api/media/draft-film')).status).toBe(404);
      expect((await supertest(ctx.app).get('/api/media/nope')).status).toBe(404);
    });
  });

  describe('guides', () => {
    it('lists published guides without their bodies and filters by category', async () => {
      const res = await supertest(ctx.app).get('/api/guides');
      expect(slugs(res)).toEqual(['vegan-101', 'outreach-101']);
      for (const item of res.body.items) expect(item.body).toBeUndefined();
      expect(res.body.items[1]).toMatchObject({
        summary: 'How to start a conversation.',
        sources: [{ title: 'AV', url: 'https://example.org/av', license: null }],
      });

      const category = await supertest(ctx.app).get('/api/guides').query({ category: 'outreach' });
      expect(slugs(category)).toEqual(['outreach-101']);
    });

    it('gets a published guide with its body and hides drafts', async () => {
      const ok = await supertest(ctx.app).get('/api/guides/outreach-101');
      expect(ok.status).toBe(200);
      expect(ok.body.guide.body).toBe('# Outreach\n\nSay hello.');
      expect((await supertest(ctx.app).get('/api/guides/draft-guide')).status).toBe(404);
      expect((await supertest(ctx.app).get('/api/guides/nope')).status).toBe(404);
    });
  });

  it('counts the catalogue in /api/stats', async () => {
    const res = await supertest(ctx.app).get('/api/stats');
    expect(res.body).toMatchObject({ organizations: 2, groves: 2, media: 3, guides: 2 });
  });
});
