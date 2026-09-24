import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MagicLinkModel, UserModel } from '../src/models/index.js';
import { bearer, createTestContext, registerUser, type TestContext } from './helpers/app.js';

describe('auth', () => {
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

  describe('POST /api/auth/register', () => {
    it('creates a member and returns a session token once', async () => {
      const res = await supertest(ctx.app)
        .post('/api/auth/register')
        .send({ email: 'ada@example.org', password: 'correct horse battery', handle: 'ada' });

      expect(res.status).toBe(201);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.length).toBeGreaterThanOrEqual(43);
      expect(res.body.user).toMatchObject({
        email: 'ada@example.org',
        handle: 'ada',
        role: 'member',
        homeArea: 'other',
        discoverable: false,
        publicPostsEnabled: false,
        hasPassword: true,
      });
      expect(res.body.user.passwordHash).toBeUndefined();

      const stored = await UserModel.findOne({ handle: 'ada' });
      expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('normalizes email and handle case and whitespace', async () => {
      const res = await supertest(ctx.app).post('/api/auth/register').send({
        email: '  Grace.H@Example.COM ',
        password: 'correct horse battery',
        handle: ' Grace_H ',
      });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('grace.h@example.com');
      expect(res.body.user.handle).toBe('grace_h');

      const login = await supertest(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'GRACE.H@example.com', password: 'correct horse battery' });
      expect(login.status).toBe(200);
    });

    it('rejects a duplicate email regardless of case', async () => {
      await registerUser(ctx.app, { email: 'dup@example.org', handle: 'first' });
      const res = await supertest(ctx.app)
        .post('/api/auth/register')
        .send({ email: 'DUP@example.org', password: 'correct horse battery', handle: 'second' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('email_taken');
    });

    it('rejects a taken handle regardless of case', async () => {
      await registerUser(ctx.app, { handle: 'taken_one' });
      const res = await supertest(ctx.app).post('/api/auth/register').send({
        email: 'other@example.org',
        password: 'correct horse battery',
        handle: 'Taken_One',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('handle_taken');
    });

    it('rejects reserved handles', async () => {
      const res = await supertest(ctx.app)
        .post('/api/auth/register')
        .send({ email: 'x@example.org', password: 'correct horse battery', handle: 'admin' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('handle_taken');
    });

    it('validates handle shape, email and password length', async () => {
      const res = await supertest(ctx.app)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: 'short', handle: 'bad handle!' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      const paths = res.body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.password', 'body.handle']));
    });
  });

  describe('POST /api/auth/login', () => {
    it('signs in with the right password', async () => {
      await registerUser(ctx.app, {
        email: 'login@example.org',
        password: 'correct horse battery',
      });
      const res = await supertest(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'login@example.org', password: 'correct horse battery' });
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user.email).toBe('login@example.org');
    });

    it('rejects a wrong password and an unknown email with the same error', async () => {
      await registerUser(ctx.app, {
        email: 'login2@example.org',
        password: 'correct horse battery',
      });
      const wrong = await supertest(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'login2@example.org', password: 'wrong horse battery' });
      const unknown = await supertest(ctx.app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.org', password: 'correct horse battery' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body.error.code).toBe('unauthenticated');
    });
  });

  describe('magic link', () => {
    it('always answers 202 and only emails known members', async () => {
      await registerUser(ctx.app, { email: 'known@example.org' });

      const known = await supertest(ctx.app)
        .post('/api/auth/magic-link')
        .send({ email: 'Known@example.org' });
      const unknown = await supertest(ctx.app)
        .post('/api/auth/magic-link')
        .send({ email: 'ghost@example.org' });

      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(known.body).toEqual(unknown.body);
      expect(ctx.emails).toHaveLength(1);
      expect(ctx.emails[0]?.to).toBe('known@example.org');
      expect(ctx.emails[0]?.url).toContain('token=');

      const stored = await MagicLinkModel.findOne({ email: 'known@example.org' });
      expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored?.usedAt).toBeUndefined();
    });

    it('verifies a link once, then never again', async () => {
      await registerUser(ctx.app, { email: 'link@example.org' });
      await supertest(ctx.app).post('/api/auth/magic-link').send({ email: 'link@example.org' });
      const token = new URL(ctx.emails[0]?.url ?? '').searchParams.get('token') ?? '';
      expect(token.length).toBeGreaterThan(20);

      const first = await supertest(ctx.app).post('/api/auth/magic-link/verify').send({ token });
      expect(first.status).toBe(200);
      expect(typeof first.body.token).toBe('string');
      expect(first.body.user.email).toBe('link@example.org');
      expect(first.body.user.emailVerified).toBe(true);

      const second = await supertest(ctx.app).post('/api/auth/magic-link/verify').send({ token });
      expect(second.status).toBe(401);
      expect(second.body.error.code).toBe('invalid_magic_link');
    });

    it('rejects an expired link', async () => {
      await registerUser(ctx.app, { email: 'stale@example.org' });
      await supertest(ctx.app).post('/api/auth/magic-link').send({ email: 'stale@example.org' });
      await MagicLinkModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const token = new URL(ctx.emails[0]?.url ?? '').searchParams.get('token') ?? '';
      const res = await supertest(ctx.app).post('/api/auth/magic-link/verify').send({ token });
      expect(res.status).toBe(401);
    });
  });

  describe('sessions', () => {
    it('requires a bearer token and rejects garbage', async () => {
      const none = await supertest(ctx.app).get('/api/me');
      const bad = await supertest(ctx.app).get('/api/me').set(bearer('nope'));
      expect(none.status).toBe(401);
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe('unauthenticated');
    });

    it('logout revokes the current session', async () => {
      const { token } = await registerUser(ctx.app);
      const out = await supertest(ctx.app).post('/api/auth/logout').set(bearer(token));
      expect(out.status).toBe(204);
      const after = await supertest(ctx.app).get('/api/me').set(bearer(token));
      expect(after.status).toBe(401);
    });
  });

  describe('provider sign-in', () => {
    it('answers 503 until Apple and Google client ids are configured', async () => {
      const apple = await supertest(ctx.app)
        .post('/api/auth/apple')
        .send({ identityToken: 'x'.repeat(40), nonce: 'nonce-value-1234' });
      const google = await supertest(ctx.app)
        .post('/api/auth/google')
        .send({ idToken: 'x'.repeat(40) });
      expect(apple.status).toBe(503);
      expect(apple.body.error.code).toBe('provider_unconfigured');
      expect(google.status).toBe(503);
    });

    it('validates the provider payload shape before anything else', async () => {
      const res = await supertest(ctx.app).post('/api/auth/apple').send({ nonce: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  });
});
