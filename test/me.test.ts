import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CompanionConversationModel,
  PlaceModel,
  PlaceReviewModel,
  SessionModel,
  UserModel,
} from '../src/models/index.js';
import { bearer, createTestContext, registerUser, type TestContext } from './helpers/app.js';

describe('/api/me', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns the private view of the member', async () => {
    const { token, email, handle } = await registerUser(ctx.app);
    const res = await supertest(ctx.app).get('/api/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email, handle, interests: [], providers: [] });
  });

  describe('PATCH', () => {
    it('updates the fields a member owns', async () => {
      const { token } = await registerUser(ctx.app);
      const res = await supertest(ctx.app)
        .patch('/api/me')
        .set(bearer(token))
        .send({
          handle: 'New_Handle',
          homeArea: 'long_beach',
          interests: ['outreach', 'sanctuary'],
        });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        handle: 'new_handle',
        homeArea: 'long_beach',
        interests: ['outreach', 'sanctuary'],
      });
    });

    it("refuses fields that are not the member's to set", async () => {
      const { token } = await registerUser(ctx.app);
      const res = await supertest(ctx.app)
        .patch('/api/me')
        .set(bearer(token))
        .send({ role: 'admin' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      const me = await supertest(ctx.app).get('/api/me').set(bearer(token));
      expect(me.body.user.role).toBe('member');
    });

    it('rejects a handle another member holds, allows keeping your own', async () => {
      await registerUser(ctx.app, { handle: 'held' });
      const { token, handle } = await registerUser(ctx.app);
      const clash = await supertest(ctx.app)
        .patch('/api/me')
        .set(bearer(token))
        .send({ handle: 'HELD' });
      expect(clash.status).toBe(409);
      const same = await supertest(ctx.app).patch('/api/me').set(bearer(token)).send({ handle });
      expect(same.status).toBe(200);
    });
  });

  describe('sessions', () => {
    it('lists live sessions and marks the current one', async () => {
      const { token, email } = await registerUser(ctx.app, { password: 'correct horse battery' });
      const second = await supertest(ctx.app)
        .post('/api/auth/login')
        .send({ email, password: 'correct horse battery', client: 'ios' });

      const res = await supertest(ctx.app).get('/api/me/sessions').set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(res.body.items.map((s: { client: string }) => s.client).sort()).toEqual([
        'ios',
        'web',
      ]);
      for (const item of res.body.items) expect(item.tokenHash).toBeUndefined();

      const other = res.body.items.find((s: { current: boolean }) => !s.current);
      const revoke = await supertest(ctx.app)
        .delete(`/api/me/sessions/${other.id}`)
        .set(bearer(token));
      expect(revoke.status).toBe(204);
      const dead = await supertest(ctx.app).get('/api/me').set(bearer(second.body.token));
      expect(dead.status).toBe(401);
    });

    it('cannot revoke a session that is not yours', async () => {
      const a = await registerUser(ctx.app);
      const b = await registerUser(ctx.app);
      const bSessions = await supertest(ctx.app).get('/api/me/sessions').set(bearer(b.token));
      const res = await supertest(ctx.app)
        .delete(`/api/me/sessions/${bSessions.body.items[0].id}`)
        .set(bearer(a.token));
      expect(res.status).toBe(404);
      expect(await SessionModel.countDocuments({ userId: b.id })).toBe(1);
    });
  });

  describe('DELETE (hard delete, spec rule 10)', () => {
    it('removes the member and everything they authored, detaches what stays', async () => {
      const { token, id } = await registerUser(ctx.app);
      const submitted = await supertest(ctx.app)
        .post('/api/places')
        .set(bearer(token))
        .send({
          name: 'Detached Diner',
          type: 'restaurant',
          veganLevel: 'full',
          location: { lng: -118.19, lat: 33.77 },
        });
      expect(submitted.status).toBe(201);
      await PlaceReviewModel.create({ placeId: submitted.body.place.id, userId: id, rating: 5 });
      await CompanionConversationModel.create({ userId: id, messages: [] });

      const res = await supertest(ctx.app).delete('/api/me').set(bearer(token));
      expect(res.status).toBe(204);

      expect(await UserModel.findById(id)).toBeNull();
      expect(await SessionModel.countDocuments({ userId: id })).toBe(0);
      expect(await CompanionConversationModel.countDocuments({ userId: id })).toBe(0);

      const place = await PlaceModel.findOne({ slug: submitted.body.place.slug });
      expect(place).not.toBeNull();
      expect(place?.submittedBy).toBeUndefined();
      const review = await PlaceReviewModel.findOne({ placeId: submitted.body.place.id });
      expect(review).not.toBeNull();
      expect(review?.userId).toBeUndefined();

      const after = await supertest(ctx.app).get('/api/me').set(bearer(token));
      expect(after.status).toBe(401);
    });
  });
});
