import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { CompanionConversationModel } from '../src/models/index.js';
import {
  bearer,
  collectSse,
  createTestContext,
  fakeCompanion,
  registerUser,
  type TestContext,
} from './helpers/app.js';

function parseSse(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? 'null';
      return { event, data: JSON.parse(data) };
    });
}

describe('POST /api/companion/chat', () => {
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

  it('streams deltas as SSE and stores an unpinned, expiring conversation', async () => {
    const fake = fakeCompanion(['Hello ', '@member. ', 'Try the Places tab.']);
    ctx.setCompanion(fake);
    const { token, handle } = await registerUser(ctx.app);
    await supertest(ctx.app)
      .patch('/api/me')
      .set(bearer(token))
      .send({ interests: ['outreach'] });

    const res = await supertest(ctx.app)
      .post('/api/companion/chat')
      .set(bearer(token))
      .send({ message: 'Where should I start?' })
      .buffer(true)
      .parse(collectSse);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const frames = parseSse(res.body as string);
    expect(frames[0]?.event).toBe('meta');
    const deltas = frames
      .filter((f) => f.event === 'delta')
      .map((f) => (f.data as { text: string }).text);
    expect(deltas.join('')).toBe('Hello @member. Try the Places tab.');
    expect(frames.at(-1)).toEqual({
      event: 'done',
      data: { stopReason: 'end_turn', conversationId: expect.any(String) },
    });

    // The prompt input carried the handle and interests, nothing else.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      handle,
      interests: ['outreach'],
      history: [],
      message: 'Where should I start?',
    });

    const stored = await CompanionConversationModel.findOne({});
    expect(stored?.pinned).toBe(false);
    expect(stored?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const ttl = (stored?.expiresAt?.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("continues a conversation with its history and refuses someone else's", async () => {
    const fake = fakeCompanion(['ok']);
    ctx.setCompanion(fake);
    const { token } = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);

    const first = await supertest(ctx.app)
      .post('/api/companion/chat')
      .set(bearer(token))
      .send({ message: 'first' })
      .buffer(true)
      .parse(collectSse);
    const meta = parseSse(first.body as string)[0]?.data as { conversationId: string } | undefined;
    const conversationId = meta?.conversationId ?? '';
    expect(conversationId).toMatch(/^[a-f0-9]{24}$/);

    const second = await supertest(ctx.app)
      .post('/api/companion/chat')
      .set(bearer(token))
      .send({ message: 'second', conversationId })
      .buffer(true)
      .parse(collectSse);
    expect(second.status).toBe(200);
    expect(fake.calls[1]?.history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
    ]);

    const stolen = await supertest(ctx.app)
      .post('/api/companion/chat')
      .set(bearer(other.token))
      .send({ message: 'hi', conversationId });
    expect(stolen.status).toBe(404);
  });

  it('answers a plain JSON error when the companion is unavailable', async () => {
    ctx.setCompanion(
      fakeCompanion([], { stopReason: null }, new AppError(503, 'companion_unavailable', 'off')),
    );
    const { token } = await registerUser(ctx.app);
    const res = await supertest(ctx.app)
      .post('/api/companion/chat')
      .set(bearer(token))
      .send({ message: 'hello' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('companion_unavailable');
    expect(await CompanionConversationModel.countDocuments({})).toBe(0);
  });

  it('validates the message and requires a session', async () => {
    const anon = await supertest(ctx.app).post('/api/companion/chat').send({ message: 'x' });
    expect(anon.status).toBe(401);
    const { token } = await registerUser(ctx.app);
    const empty = await supertest(ctx.app).post('/api/companion/chat').set(bearer(token)).send({});
    expect(empty.status).toBe(400);
  });
});
