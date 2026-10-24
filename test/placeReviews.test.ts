import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlaceModel, PlaceReviewModel, ReportModel, Types } from '../src/models/index.js';
import {
  bearer,
  createTestContext,
  promoteToAdmin,
  type RegisteredUser,
  registerUser,
  type TestContext,
} from './helpers/app.js';

async function seedPlace(approvalStatus: 'approved' | 'pending' | 'rejected' = 'approved') {
  const suffix = new Types.ObjectId().toHexString().slice(-6);
  const doc = await PlaceModel.create({
    name: `Kitchen ${suffix}`,
    slug: `kitchen-${suffix}`,
    type: 'cafe',
    veganLevel: 'full',
    location: { type: 'Point', coordinates: [-118.19, 33.77] },
    approvalStatus,
    source: 'curated',
  });
  return { id: doc._id.toHexString(), slug: doc.slug };
}

describe('place reviews', () => {
  let ctx: TestContext;
  let author: RegisteredUser;
  let other: RegisteredUser;
  let admin: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
    author = await registerUser(ctx.app);
    other = await registerUser(ctx.app);
    admin = await registerUser(ctx.app);
    await promoteToAdmin(admin.id);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lists nothing until a review exists, and hides non-approved places', async () => {
    const place = await seedPlace();
    const empty = await supertest(ctx.app).get(`/api/places/${place.id}/reviews`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], nextCursor: null });
    expect(empty.headers['cache-control']).toContain('public');

    const pending = await seedPlace('pending');
    const hidden = await supertest(ctx.app).get(`/api/places/${pending.id}/reviews`);
    expect(hidden.status).toBe(404);

    const badId = await supertest(ctx.app).get('/api/places/not-an-id/reviews');
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('validation_error');
  });

  it('publishes the text and the handle only when the author opts in', async () => {
    const place = await seedPlace();
    const anonAttempt = await supertest(ctx.app)
      .post(`/api/places/${place.id}/reviews`)
      .send({ rating: 5, content: 'quiet' });
    expect(anonAttempt.status).toBe(401);

    const created = await supertest(ctx.app)
      .post(`/api/places/${place.id}/reviews`)
      .set(bearer(author.token))
      .send({
        rating: 4,
        content: '  The lentil loaf  ',
        visitedMonth: '2026-04',
        showHandle: false,
      });
    expect(created.status).toBe(201);
    expect(created.body.review).toMatchObject({
      placeId: place.id,
      rating: 4,
      content: 'The lentil loaf',
      visitedMonth: '2026-04',
      showHandle: false,
      handle: null,
      mine: true,
    });
    expect(created.body.review.userId).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain(author.id);
    expect(JSON.stringify(created.body)).not.toContain(author.email);
    expect(JSON.stringify(created.body)).not.toContain(author.handle);

    const asAuthor = await supertest(ctx.app)
      .get(`/api/places/${place.id}/reviews`)
      .set(bearer(author.token));
    expect(asAuthor.headers['cache-control']).toBe('private, no-store');
    expect(asAuthor.body.items[0].mine).toBe(true);

    const asOther = await supertest(ctx.app)
      .get(`/api/places/${place.id}/reviews`)
      .set(bearer(other.token));
    expect(asOther.body.items[0].mine).toBe(false);
    expect(asOther.body.items[0].handle).toBeNull();

    const named = await supertest(ctx.app)
      .post(`/api/places/${place.id}/reviews`)
      .set(bearer(other.token))
      .send({ rating: 2, content: 'Closed early', showHandle: true });
    expect(named.status).toBe(201);
    expect(named.body.review.handle).toBe(other.handle);
    expect(named.body.review.showHandle).toBe(true);
    expect(JSON.stringify(named.body)).not.toContain(other.id);
    expect(JSON.stringify(named.body)).not.toContain(other.email);

    const duplicate = await supertest(ctx.app)
      .post(`/api/places/${place.id}/reviews`)
      .set(bearer(author.token))
      .send({ rating: 5, content: 'again' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('review_exists');

    const listed = await supertest(ctx.app).get(`/api/places/${place.id}/reviews`);
    expect(listed.body.items).toHaveLength(2);
    expect(listed.body.items[0].mine).toBeUndefined();
    expect(listed.body.items.map((review: { handle: string | null }) => review.handle)).toContain(
      other.handle,
    );

    const detail = await supertest(ctx.app).get(`/api/places/${place.slug}`);
    expect(detail.body.place).toMatchObject({ reviewCount: 2, ratingAvg: 3 });
  });

  it('lets an admin remove and restore a review without learning who wrote it', async () => {
    const place = await seedPlace();
    const created = await supertest(ctx.app)
      .post(`/api/places/${place.id}/reviews`)
      .set(bearer(author.token))
      .send({ rating: 5, content: 'Worth the trip', showHandle: false });
    const reviewId = created.body.review.id as string;

    const asMember = await supertest(ctx.app)
      .put(`/api/admin/reviews/${reviewId}`)
      .set(bearer(author.token))
      .send({ status: 'removed' });
    expect(asMember.status).toBe(403);

    const removed = await supertest(ctx.app)
      .put(`/api/admin/reviews/${reviewId}`)
      .set(bearer(admin.token))
      .send({ status: 'removed' });
    expect(removed.status).toBe(200);
    expect(removed.body.review.status).toBe('removed');
    expect(removed.body.review.userId).toBeUndefined();
    expect(removed.body.review.handle).toBeNull();
    expect(JSON.stringify(removed.body)).not.toContain(author.id);
    expect(JSON.stringify(removed.body)).not.toContain(author.handle);

    const hidden = await supertest(ctx.app).get(`/api/places/${place.id}/reviews`);
    expect(hidden.body.items).toEqual([]);
    const afterRemoval = await supertest(ctx.app).get(`/api/places/${place.slug}`);
    expect(afterRemoval.body.place).toMatchObject({ reviewCount: 0, ratingAvg: 0 });

    const queue = await supertest(ctx.app)
      .get('/api/admin/reviews')
      .query({ status: 'removed' })
      .set(bearer(admin.token));
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((review: { id: string }) => review.id)).toEqual([reviewId]);

    const again = await supertest(ctx.app)
      .post(`/api/places/${place.id}/reviews`)
      .set(bearer(author.token))
      .send({ rating: 3, content: 'Second visit', showHandle: true });
    expect(again.status).toBe(201);

    const restored = await supertest(ctx.app)
      .put(`/api/admin/reviews/${reviewId}`)
      .set(bearer(admin.token))
      .send({ status: 'active' });
    expect(restored.status).toBe(409);
    expect(restored.body.error.code).toBe('review_exists');

    const kept = await supertest(ctx.app)
      .put(`/api/admin/reviews/${again.body.review.id}`)
      .set(bearer(admin.token))
      .send({ status: 'removed' });
    expect(kept.status).toBe(200);
    const broughtBack = await supertest(ctx.app)
      .put(`/api/admin/reviews/${reviewId}`)
      .set(bearer(admin.token))
      .send({ status: 'active' });
    expect(broughtBack.status).toBe(200);
    expect(broughtBack.body.review.handle).toBeNull();
  });

  it('is a report target, and the reporter is not returned', async () => {
    const place = await seedPlace();
    const created = await supertest(ctx.app)
      .post(`/api/places/${place.id}/reviews`)
      .set(bearer(author.token))
      .send({ rating: 1, content: 'Not vegan anymore', showHandle: true });
    const reviewId = created.body.review.id as string;

    const own = await supertest(ctx.app)
      .post('/api/reports')
      .set(bearer(author.token))
      .send({ targetType: 'review', targetId: reviewId, reason: 'I changed my mind' });
    expect(own.status).toBe(403);
    expect(await ReportModel.countDocuments({ targetId: reviewId })).toBe(0);

    const filed = await supertest(ctx.app)
      .post('/api/reports')
      .set(bearer(other.token))
      .send({ targetType: 'review', targetId: reviewId, reason: 'Harasses the staff' });
    expect(filed.status).toBe(201);
    expect(filed.body.report).toMatchObject({
      targetType: 'review',
      targetId: reviewId,
      reason: 'Harasses the staff',
      status: 'open',
    });
    expect(filed.body.report.reportedBy).toBeUndefined();
    expect(JSON.stringify(filed.body)).not.toContain(other.id);
    expect(JSON.stringify(filed.body)).not.toContain(other.email);

    const stored = await ReportModel.findById(filed.body.report.id);
    expect(stored?.reportedBy?.toHexString()).toBe(other.id);

    const duplicate = await supertest(ctx.app)
      .post('/api/reports')
      .set(bearer(other.token))
      .send({ targetType: 'review', targetId: reviewId, reason: 'Still there' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('already_reported');

    const missing = await supertest(ctx.app).post('/api/reports').set(bearer(other.token)).send({
      targetType: 'review',
      targetId: new Types.ObjectId().toHexString(),
      reason: 'gone',
    });
    expect(missing.status).toBe(404);

    await PlaceReviewModel.updateOne({ _id: reviewId }, { $set: { status: 'removed' } });
    const removed = await supertest(ctx.app)
      .post('/api/reports')
      .set(bearer(author.token))
      .send({ targetType: 'review', targetId: reviewId, reason: 'still up' });
    expect(removed.status).toBe(404);
  });

  it('rejects a review of a place that is not on the map', async () => {
    const pending = await seedPlace('pending');
    const rejected = await seedPlace('rejected');
    for (const place of [pending, rejected]) {
      const res = await supertest(ctx.app)
        .post(`/api/places/${place.id}/reviews`)
        .set(bearer(author.token))
        .send({ rating: 5, content: 'secret' });
      expect(res.status).toBe(404);
    }
    const bad = await supertest(ctx.app)
      .post(`/api/places/${pending.id}/reviews`)
      .set(bearer(author.token))
      .send({ rating: 9, userId: author.id });
    expect(bad.status).toBe(400);
  });
});
