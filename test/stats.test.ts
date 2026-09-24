import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuideModel, type Place, PlaceModel } from '../src/models/index.js';
import { createTestContext, type TestContext } from './helpers/app.js';

type SeedPlace = Pick<
  Place,
  'name' | 'slug' | 'type' | 'veganLevel' | 'approvalStatus' | 'source'
> & {
  location: { type: 'Point'; coordinates: [number, number] };
};

const place = (slug: string, approvalStatus: Place['approvalStatus']): SeedPlace => ({
  name: slug,
  slug,
  type: 'restaurant',
  veganLevel: 'full',
  location: { type: 'Point', coordinates: [-118.25, 34.05] },
  approvalStatus,
  source: 'curated',
});

describe('GET /api/stats', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await PlaceModel.create([
      place('approved-one', 'approved'),
      place('approved-two', 'approved'),
      place('pending-one', 'pending'),
    ]);
    await GuideModel.create([
      {
        title: 'Published',
        slug: 'published',
        category: 'vegan101',
        body: 'x',
        status: 'published',
      },
      { title: 'Draft', slug: 'draft', category: 'vegan101', body: 'x', status: 'draft' },
    ]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('counts only approved and published rows, publicly', async () => {
    const res = await supertest(ctx.app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      places: 2,
      guides: 1,
      upcomingEvents: 0,
      groves: 0,
      media: 0,
      members: 0,
    });
    expect(res.headers['cache-control']).toContain('max-age=300');
  });

  it('serves the cached value for 5 minutes', async () => {
    const first = await supertest(ctx.app).get('/api/stats');
    await PlaceModel.create(place('approved-three', 'approved'));
    const second = await supertest(ctx.app).get('/api/stats');
    expect(second.body.places).toBe(first.body.places);
    expect(second.body.generatedAt).toBe(first.body.generatedAt);
  });
});
