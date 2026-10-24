import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlaceListModel, PlaceModel, Types } from '../src/models/index.js';
import {
  bearer,
  createTestContext,
  type RegisteredUser,
  registerUser,
  type TestContext,
} from './helpers/app.js';

async function seedPlace(name: string, approvalStatus: 'approved' | 'pending' = 'approved') {
  const doc = await PlaceModel.create({
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    type: 'restaurant',
    veganLevel: 'full',
    location: { type: 'Point', coordinates: [-118.19, 33.77] },
    approvalStatus,
    source: 'curated',
  });
  return doc._id.toHexString();
}

describe('/api/place-lists', () => {
  let ctx: TestContext;
  let owner: RegisteredUser;
  let other: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = await registerUser(ctx.app);
    other = await registerUser(ctx.app);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('requires a session and returns only the caller’s lists', async () => {
    const anon = await supertest(ctx.app).get('/api/place-lists');
    expect(anon.status).toBe(401);

    const created = await supertest(ctx.app)
      .post('/api/place-lists')
      .set(bearer(owner.token))
      .send({ name: 'Want to try', isPublic: true });
    expect(created.status).toBe(201);
    expect(created.body.list).toMatchObject({
      name: 'Want to try',
      isPublic: true,
      placeIds: [],
      places: [],
    });
    expect(created.body.list.userId).toBeUndefined();
    expect(created.headers['cache-control']).toBe('private, no-store');

    const mine = await supertest(ctx.app).get('/api/place-lists').set(bearer(owner.token));
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.nextCursor).toBeNull();

    const theirs = await supertest(ctx.app).get('/api/place-lists').set(bearer(other.token));
    expect(theirs.body.items).toEqual([]);

    const hidden = await supertest(ctx.app)
      .get(`/api/place-lists/${created.body.list.id}`)
      .set(bearer(other.token));
    expect(hidden.status).toBe(404);
  });

  it('updates, reads, and deletes a list for the owner only', async () => {
    const created = await supertest(ctx.app)
      .post('/api/place-lists')
      .set(bearer(owner.token))
      .send({ name: 'Volunteer here' });
    const id = created.body.list.id as string;

    const renamed = await supertest(ctx.app)
      .patch(`/api/place-lists/${id}`)
      .set(bearer(owner.token))
      .send({ name: 'Sanctuary days' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.list.name).toBe('Sanctuary days');

    const otherPatch = await supertest(ctx.app)
      .patch(`/api/place-lists/${id}`)
      .set(bearer(other.token))
      .send({ name: 'nope' });
    expect(otherPatch.status).toBe(404);

    const got = await supertest(ctx.app).get(`/api/place-lists/${id}`).set(bearer(owner.token));
    expect(got.body.list.name).toBe('Sanctuary days');

    const removed = await supertest(ctx.app)
      .delete(`/api/place-lists/${id}`)
      .set(bearer(owner.token));
    expect(removed.status).toBe(204);
    expect(await PlaceListModel.countDocuments({ _id: id })).toBe(0);

    const gone = await supertest(ctx.app).get(`/api/place-lists/${id}`).set(bearer(owner.token));
    expect(gone.status).toBe(404);
  });

  it('adds and removes places without duplicating, and embeds the place', async () => {
    const placeId = await seedPlace('Seed Kitchen');
    const pendingId = await seedPlace('Still Pending', 'pending');
    const created = await supertest(ctx.app)
      .post('/api/place-lists')
      .set(bearer(owner.token))
      .send({ name: 'Nearby', placeIds: [placeId, placeId] });
    expect(created.body.list.placeIds).toEqual([placeId]);
    expect(created.body.list.places[0]).toMatchObject({
      id: placeId,
      name: 'Seed Kitchen',
      veganLevel: 'full',
    });
    expect(created.body.list.places[0].submittedBy).toBeUndefined();
    expect(created.body.list.places[0].lastAgreeingCheckInAt).toBeUndefined();

    const id = created.body.list.id as string;
    const again = await supertest(ctx.app)
      .post(`/api/place-lists/${id}/places`)
      .set(bearer(owner.token))
      .send({ placeId });
    expect(again.status).toBe(200);
    expect(again.body.list.placeIds).toEqual([placeId]);

    const addedPending = await supertest(ctx.app)
      .post(`/api/place-lists/${id}/places`)
      .set(bearer(owner.token))
      .send({ placeId: pendingId });
    expect(addedPending.body.list.placeIds).toEqual([placeId, pendingId]);
    expect(
      addedPending.body.list.places.map((p: { approvalStatus: string }) => p.approvalStatus),
    ).toEqual(['approved', 'pending']);

    const stranger = await supertest(ctx.app)
      .post(`/api/place-lists/${id}/places`)
      .set(bearer(other.token))
      .send({ placeId });
    expect(stranger.status).toBe(404);

    const missing = await supertest(ctx.app)
      .post(`/api/place-lists/${id}/places`)
      .set(bearer(owner.token))
      .send({ placeId: new Types.ObjectId().toHexString() });
    expect(missing.status).toBe(404);

    const removed = await supertest(ctx.app)
      .delete(`/api/place-lists/${id}/places/${placeId}`)
      .set(bearer(owner.token));
    expect(removed.body.list.placeIds).toEqual([pendingId]);

    const removedAgain = await supertest(ctx.app)
      .delete(`/api/place-lists/${id}/places/${placeId}`)
      .set(bearer(owner.token));
    expect(removedAgain.status).toBe(200);
    expect(removedAgain.body.list.placeIds).toEqual([pendingId]);
  });

  it('rejects a 501st distinct place and invalid bodies', async () => {
    const placeId = await seedPlace('Cap Kitchen');
    const created = await supertest(ctx.app)
      .post('/api/place-lists')
      .set(bearer(owner.token))
      .send({ name: 'Full' });
    const id = created.body.list.id as string;
    await PlaceListModel.updateOne(
      { _id: id },
      { $set: { placeIds: Array.from({ length: 500 }, () => new Types.ObjectId()) } },
    );
    const full = await supertest(ctx.app)
      .post(`/api/place-lists/${id}/places`)
      .set(bearer(owner.token))
      .send({ placeId });
    expect(full.status).toBe(400);
    expect(full.body.error.code).toBe('list_full');

    const bad = await supertest(ctx.app)
      .post('/api/place-lists')
      .set(bearer(owner.token))
      .send({ name: '', userId: owner.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('paginates the owner’s lists newest first', async () => {
    for (const name of ['one', 'two', 'three']) {
      const res = await supertest(ctx.app)
        .post('/api/place-lists')
        .set(bearer(owner.token))
        .send({ name });
      expect(res.status).toBe(201);
    }
    const first = await supertest(ctx.app)
      .get('/api/place-lists')
      .query({ limit: 2 })
      .set(bearer(owner.token));
    expect(first.body.items.map((list: { name: string }) => list.name)).toEqual(['three', 'two']);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await supertest(ctx.app)
      .get('/api/place-lists')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set(bearer(owner.token));
    expect(second.body.items.map((list: { name: string }) => list.name)).toEqual(['one']);
    expect(second.body.nextCursor).toBeNull();
  });
});
