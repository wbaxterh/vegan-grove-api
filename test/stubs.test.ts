import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestContext,
  promoteToAdmin,
  type RegisteredUser,
  registerUser,
  type TestContext,
} from './helpers/app.js';

/**
 * Every milestone-2 route exists, is mounted, validates, and answers 501 in
 * the standard shape. These are the contract the clients can build against.
 */
describe('not-yet-implemented routes', () => {
  let ctx: TestContext;
  let member: RegisteredUser;
  let admin: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestContext();
    member = await registerUser(ctx.app);
    admin = await registerUser(ctx.app);
    await promoteToAdmin(admin.id);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const publicGets = [
    '/api/events',
    '/api/events/some-slug',
    '/api/groves',
    '/api/groves/some-slug',
    '/api/organizations',
    '/api/organizations/some-slug',
    '/api/media',
    '/api/media/some-slug',
    '/api/guides',
    '/api/guides/some-slug',
    '/api/handles/someone/posts',
    '/api/places/000000000000000000000000/reviews',
  ];

  it.each(publicGets)('GET %s answers 501 not_implemented', async (path) => {
    const res = await supertest(ctx.app).get(path);
    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      error: { code: 'not_implemented', message: expect.any(String) },
    });
  });

  const authedGets = [
    '/api/place-lists',
    '/api/friends',
    '/api/friends/requests',
    '/api/feed',
    '/api/conversations',
    '/api/actions',
    '/api/companion/conversations',
    '/api/me/notification-preferences',
  ];

  it.each(authedGets)('GET %s needs a session, then answers 501', async (path) => {
    const anon = await supertest(ctx.app).get(path);
    expect(anon.status).toBe(401);
    const res = await supertest(ctx.app).get(path).set(bearer(member.token));
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('not_implemented');
  });

  it('validates bodies before answering 501', async () => {
    const bad = await supertest(ctx.app).post('/api/posts').set(bearer(member.token)).send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');

    const ok = await supertest(ctx.app)
      .post('/api/posts')
      .set(bearer(member.token))
      .send({ mediaType: 'image', imageKeys: ['post/2026/09/x.jpg'], caption: 'hi' });
    expect(ok.status).toBe(501);

    const report = await supertest(ctx.app)
      .post('/api/reports')
      .set(bearer(member.token))
      .send({ targetType: 'post', targetId: '000000000000000000000000', reason: 'spam' });
    expect(report.status).toBe(501);

    const presign = await supertest(ctx.app)
      .post('/api/uploads/image/presign')
      .set(bearer(member.token))
      .send({ contentType: 'image/gif', purpose: 'post' });
    expect(presign.status).toBe(400);
  });

  it('keeps admin CRUD behind the admin gate', async () => {
    const asMember = await supertest(ctx.app).get('/api/admin/reports').set(bearer(member.token));
    expect(asMember.status).toBe(403);
    const asAdmin = await supertest(ctx.app).get('/api/admin/reports').set(bearer(admin.token));
    expect(asAdmin.status).toBe(501);
    const badGuide = await supertest(ctx.app)
      .post('/api/admin/guides')
      .set(bearer(admin.token))
      .send({ title: 'x' });
    expect(badGuide.status).toBe(400);
  });

  it('rejects malformed JSON and oversized bodies in the standard shape', async () => {
    const malformed = await supertest(ctx.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('invalid_json');

    const huge = await supertest(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'a@b.co', password: 'x'.repeat(1_100_000) });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('payload_too_large');
  });
});
