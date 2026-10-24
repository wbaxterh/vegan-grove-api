import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlaceCheckInModel, PlaceModel, Types } from '../src/models/index.js';
import { currentUtcMonth } from '../src/services/checkIns.js';
import {
  bearer,
  createTestContext,
  type RegisteredUser,
  registerUser,
  type TestContext,
} from './helpers/app.js';

async function seedPlace(
  veganLevel: 'full' | 'options' = 'full',
  approvalStatus: 'approved' | 'pending' = 'approved',
) {
  const suffix = new Types.ObjectId().toHexString().slice(-6);
  const doc = await PlaceModel.create({
    name: `Garden ${suffix}`,
    slug: `garden-${suffix}`,
    type: 'garden',
    veganLevel,
    location: { type: 'Point', coordinates: [-118.19, 33.77] },
    approvalStatus,
    source: 'curated',
  });
  return { id: doc._id.toHexString(), slug: doc.slug };
}

describe('place check-ins', () => {
  let ctx: TestContext;
  let member: RegisteredUser;
  let other: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
    member = await registerUser(ctx.app);
    other = await registerUser(ctx.app);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('publishes an empty aggregate and nothing about people', async () => {
    const place = await seedPlace();
    const res = await supertest(ctx.app).get(`/api/places/${place.id}/check-ins`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checkInCount: 0,
      latestCheckInMonth: null,
      verification: 'unverified',
    });
    expect(res.headers['cache-control']).toContain('public');

    const pending = await seedPlace('full', 'pending');
    const hidden = await supertest(ctx.app).get(`/api/places/${pending.id}/check-ins`);
    expect(hidden.status).toBe(404);
  });

  it('counts an agreeing visit without recording who went', async () => {
    const place = await seedPlace();
    const month = currentUtcMonth();
    const anon = await supertest(ctx.app)
      .post(`/api/places/${place.id}/check-ins`)
      .send({ veganLevel: 'full' });
    expect(anon.status).toBe(401);

    const created = await supertest(ctx.app)
      .post(`/api/places/${place.id}/check-ins`)
      .set(bearer(member.token))
      .send({ veganLevel: 'full', rating: 5, userId: other.id });
    expect(created.status).toBe(400);

    const ok = await supertest(ctx.app)
      .post(`/api/places/${place.id}/check-ins`)
      .set(bearer(member.token))
      .send({ veganLevel: 'full', rating: 5 });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({
      checkInCount: 1,
      latestCheckInMonth: month,
      verification: 'verified',
    });
    const body = JSON.stringify(ok.body);
    expect(body).not.toContain(member.id);
    expect(body).not.toContain(member.handle);
    expect(body).not.toContain(member.email);
    expect(body).not.toContain('rating');
    expect(body).not.toContain('first');

    const row = await PlaceCheckInModel.findOne({ placeId: place.id });
    expect(row?.userId?.toHexString()).toBe(member.id);
    expect(row?.rating).toBe(5);
    expect(row?.month).toBe(month);

    const again = await supertest(ctx.app)
      .post(`/api/places/${place.id}/check-ins`)
      .set(bearer(member.token))
      .send({ veganLevel: 'full' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_checked_in');

    const second = await supertest(ctx.app)
      .post(`/api/places/${place.id}/check-ins`)
      .set(bearer(other.token))
      .send({ veganLevel: 'full' });
    expect(second.body.checkInCount).toBe(2);

    const detail = await supertest(ctx.app).get(`/api/places/${place.slug}`);
    expect(detail.body.place).toMatchObject({
      checkInCount: 2,
      latestCheckInMonth: month,
      verification: 'verified',
    });
    expect(detail.body.place.lastAgreeingCheckInAt).toBeUndefined();
    expect(detail.body.place.userId).toBeUndefined();

    const listed = await supertest(ctx.app).get(`/api/places/${place.id}/check-ins`);
    expect(listed.body).toEqual(second.body);
    expect(Object.keys(listed.body).sort()).toEqual([
      'checkInCount',
      'latestCheckInMonth',
      'verification',
    ]);
  });

  it('stays unverified when the visit disagrees, and expires after 180 days', async () => {
    const place = await seedPlace('full');
    const disagreed = await supertest(ctx.app)
      .post(`/api/places/${place.id}/check-ins`)
      .set(bearer(member.token))
      .send({ veganLevel: 'options' });
    expect(disagreed.body).toMatchObject({
      checkInCount: 1,
      verification: 'unverified',
    });

    const agreed = await seedPlace('full');
    await supertest(ctx.app)
      .post(`/api/places/${agreed.id}/check-ins`)
      .set(bearer(member.token))
      .send({ veganLevel: 'full' });
    await PlaceModel.updateOne(
      { _id: agreed.id },
      { $set: { lastAgreeingCheckInAt: new Date(Date.now() - 181 * 24 * 60 * 60 * 1000) } },
    );
    const stale = await supertest(ctx.app).get(`/api/places/${agreed.id}/check-ins`);
    expect(stale.body.verification).toBe('unverified');
    expect(stale.body.checkInCount).toBe(1);
  });

  it('does not offer a per-person history', async () => {
    const place = await seedPlace();
    await supertest(ctx.app)
      .post(`/api/places/${place.id}/check-ins`)
      .set(bearer(member.token))
      .send({ veganLevel: 'full' });
    const mine = await supertest(ctx.app).get('/api/me/check-ins').set(bearer(member.token));
    expect(mine.status).toBe(404);
  });
});
