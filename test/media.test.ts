import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaCollectionModel, MediaItemModel, type Types } from '../src/models/index.js';
import { ingestItems } from '../src/services/ingest.js';
import {
  bearer,
  createTestContext,
  promoteToAdmin,
  type RegisteredUser,
  registerUser,
  type TestContext,
} from './helpers/app.js';

const slugs = (body: { items: { slug: string }[] }) => body.items.map((i) => i.slug);

describe('media library (spec section 10)', () => {
  let ctx: TestContext;
  let member: RegisteredUser;
  let admin: RegisteredUser;
  let dominionId: string;

  beforeAll(async () => {
    ctx = await createTestContext({ MEDIA_CDN_ORIGIN: 'https://media.example.test/' });
    const rows = await MediaItemModel.create([
      {
        title: 'Dominion',
        slug: 'dominion',
        kind: 'documentary',
        year: 2018,
        status: 'published',
        featured: true,
        tags: ['ethics', 'investigation', 'tmdb', 'Watch providers data by JustWatch'],
        genres: ['Documentary'],
        runtimeMinutes: 120,
        rating: 8.7,
        ratingCount: 400,
        posterKey: 'media/posters/1.jpg',
        backdropKey: 'media/backdrops/1.jpg',
        watchLinks: [{ provider: 'YouTube', url: 'https://example.test/d', access: 'free' }],
        directors: ['Chris Delforce'],
        contentWarnings: ['graphic footage'],
        actions: [
          { label: 'Sign', url: 'https://example.test/sign', type: 'petition', org: 'Org' },
        ],
      },
      {
        title: 'Earthlings',
        slug: 'earthlings',
        kind: 'documentary',
        year: 2005,
        status: 'published',
        tags: ['ethics'],
        genres: ['Documentary'],
        runtimeMinutes: 95,
        rating: 8.5,
        watchLinks: [{ provider: 'Vimeo', url: 'https://example.test/e', access: 'free' }],
      },
      {
        title: 'The Game Changers',
        slug: 'the-game-changers',
        kind: 'documentary',
        year: 2018,
        status: 'published',
        tags: ['health'],
        genres: ['Documentary'],
        runtimeMinutes: 85,
        rating: 7.9,
        watchLinks: [
          { provider: 'Netflix', url: 'https://example.test/g', access: 'subscription' },
        ],
      },
      {
        title: 'A Short Outreach Talk',
        slug: 'a-short-outreach-talk',
        kind: 'talk',
        year: 2021,
        status: 'published',
        featured: true,
        tags: ['activism'],
        runtimeMinutes: 12,
      },
      { title: 'Draft Film', slug: 'draft-film', kind: 'film', status: 'draft', tags: ['ethics'] },
      {
        title: 'Okja',
        slug: 'okja',
        kind: 'film',
        year: 2017,
        status: 'published',
        tags: ['ethics'],
        genres: ['Adventure', 'Drama'],
      },
    ]);
    const id = (i: number) => rows[i]?._id as Types.ObjectId;
    dominionId = id(0).toHexString();
    await MediaCollectionModel.create([
      {
        slug: 'start-here',
        name: 'Start here',
        description: 'Four films that change minds.',
        order: 1,
        published: true,
        itemIds: [id(1), id(4), id(0)],
      },
      { slug: 'hidden', name: 'Hidden', published: false, itemIds: [id(0)] },
    ]);
    member = await registerUser(ctx.app);
    admin = await registerUser(ctx.app);
    await promoteToAdmin(admin.id);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('public reads', () => {
    it('serves the home rows: collections in editor order, then automatic rows with two or more items', async () => {
      const res = await supertest(ctx.app).get('/api/media/home');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('public');
      expect(res.body.hero.map((h: { slug: string }) => h.slug).sort()).toEqual([
        'a-short-outreach-talk',
        'dominion',
      ]);
      // The one with a backdrop leads so the billboard has an image.
      expect(res.body.hero[0].slug).toBe('dominion');
      expect(res.body.hero[0].backdropUrl).toBe('https://media.example.test/media/backdrops/1.jpg');
      const keys = res.body.rows.map((r: { key: string }) => r.key);
      expect(keys[0]).toBe('collection:start-here');
      expect(keys).not.toContain('collection:hidden');
      expect(keys).toContain('auto:newest');
      expect(keys).toContain('auto:free');
      expect(keys).toContain('auto:tag:ethics');
      // Only one talk is under 30 minutes and only one health title: rows need two.
      expect(keys).not.toContain('auto:short');
      expect(keys).not.toContain('auto:tag:health');
      const startHere = res.body.rows[0];
      expect(startHere).toMatchObject({ kind: 'collection', slug: 'start-here' });
      // Draft members drop out; the editor's order survives.
      expect(startHere.items.map((i: { slug: string }) => i.slug)).toEqual([
        'earthlings',
        'dominion',
      ]);
    });

    it('lists with search, filters and every sort, keeping drafts out', async () => {
      const all = await supertest(ctx.app).get('/api/media');
      expect(all.status).toBe(200);
      expect(slugs(all.body)).not.toContain('draft-film');
      expect(slugs(all.body).slice(0, 2).sort()).toEqual(['a-short-outreach-talk', 'dominion']);

      const q = await supertest(ctx.app).get('/api/media').query({ q: 'delforce' });
      expect(slugs(q.body)).toEqual(['dominion']);
      const free = await supertest(ctx.app).get('/api/media').query({ free: '1', sort: 'title' });
      expect(slugs(free.body)).toEqual(['dominion', 'earthlings']);
      const short = await supertest(ctx.app).get('/api/media').query({ maxRuntime: 90 });
      expect(slugs(short.body).sort()).toEqual(['a-short-outreach-talk', 'the-game-changers']);
      const year = await supertest(ctx.app).get('/api/media').query({ year: 2018, sort: 'title' });
      expect(slugs(year.body)).toEqual(['dominion', 'the-game-changers']);

      const release = await supertest(ctx.app).get('/api/media').query({ sort: 'release' });
      expect(slugs(release.body)[0]).toBe('a-short-outreach-talk');
      const rating = await supertest(ctx.app).get('/api/media').query({ sort: 'rating' });
      expect(slugs(rating.body).slice(0, 3)).toEqual([
        'dominion',
        'earthlings',
        'the-game-changers',
      ]);
      expect(slugs(rating.body).at(-1)).not.toBe('dominion');
      const runtime = await supertest(ctx.app).get('/api/media').query({ sort: 'runtime' });
      expect(slugs(runtime.body)).toEqual([
        'a-short-outreach-talk',
        'the-game-changers',
        'earthlings',
        'dominion',
      ]);

      // Cursor pagination on a keyset sort.
      const first = await supertest(ctx.app).get('/api/media').query({ sort: 'title', limit: 2 });
      expect(first.body.nextCursor).toBeTruthy();
      const second = await supertest(ctx.app)
        .get('/api/media')
        .query({ sort: 'title', limit: 2, cursor: first.body.nextCursor });
      expect([...slugs(first.body), ...slugs(second.body)]).toEqual([
        'a-short-outreach-talk',
        'dominion',
        'earthlings',
        'okja',
      ]);
    });

    it('serves one title with its full shape, and related titles by shared topics', async () => {
      const res = await supertest(ctx.app).get('/api/media/dominion');
      expect(res.status).toBe(200);
      expect(res.body.viewer).toBeUndefined();
      expect(res.body.media).toMatchObject({
        slug: 'dominion',
        posterUrl: 'https://media.example.test/media/posters/1.jpg',
        runtimeMinutes: 120,
        directors: ['Chris Delforce'],
        contentWarnings: ['graphic footage'],
        watchLinks: [{ provider: 'YouTube', access: 'free' }],
        actions: [{ label: 'Sign', type: 'petition', org: 'Org' }],
        stats: { saves: 0, moved: 0, acted: 0 },
      });
      expect((await supertest(ctx.app).get('/api/media/draft-film')).status).toBe(404);

      const related = await supertest(ctx.app).get('/api/media/dominion/related');
      expect(related.status).toBe(200);
      // Earthlings shares a topic and a genre; Okja a topic; Game Changers a genre only.
      expect(slugs(related.body)).toEqual(['earthlings', 'okja', 'the-game-changers']);
      expect((await supertest(ctx.app).get('/api/media/nope/related')).status).toBe(404);
    });

    it('serves published collections with previews and the full page', async () => {
      const list = await supertest(ctx.app).get('/api/media/collections');
      expect(list.status).toBe(200);
      expect(list.body.items.map((c: { slug: string }) => c.slug)).toEqual(['start-here']);
      const one = await supertest(ctx.app).get('/api/media/collections/start-here');
      expect(one.body.collection.items.map((i: { slug: string }) => i.slug)).toEqual([
        'earthlings',
        'dominion',
      ]);
      expect((await supertest(ctx.app).get('/api/media/collections/hidden')).status).toBe(404);
    });
  });

  describe('member state', () => {
    it('saves to a private watchlist, idempotently, and counts once', async () => {
      const auth = bearer(member.token);
      expect((await supertest(ctx.app).post(`/api/media/${dominionId}/save`)).status).toBe(401);
      const on = await supertest(ctx.app).post(`/api/media/${dominionId}/save`).set(auth);
      expect(on.status).toBe(200);
      expect(on.body).toEqual({ saved: true });
      await supertest(ctx.app).post(`/api/media/${dominionId}/save`).set(auth);

      const detail = await supertest(ctx.app).get('/api/media/dominion').set(auth);
      expect(detail.headers['cache-control']).toContain('private');
      expect(detail.body.viewer).toEqual({ saved: true, reactions: [] });
      expect(detail.body.media.stats.saves).toBe(1);

      const list = await supertest(ctx.app).get('/api/me/watchlist').set(auth);
      expect(list.status).toBe(200);
      expect(slugs(list.body)).toEqual(['dominion']);
      // Another member sees nothing of it.
      const other = await supertest(ctx.app).get('/api/me/watchlist').set(bearer(admin.token));
      expect(other.body.items).toEqual([]);

      const off = await supertest(ctx.app).delete(`/api/media/${dominionId}/save`).set(auth);
      expect(off.body).toEqual({ saved: false });
      expect((await supertest(ctx.app).get('/api/media/dominion')).body.media.stats.saves).toBe(0);

      const draft = await MediaItemModel.findOne({ slug: 'draft-film' });
      expect(
        (await supertest(ctx.app).post(`/api/media/${draft?._id}/save`).set(auth)).status,
      ).toBe(404);
    });

    it('records the two reactions per member and answers counts plus the viewer', async () => {
      const auth = bearer(member.token);
      const bad = await supertest(ctx.app)
        .post(`/api/media/${dominionId}/reactions`)
        .set(auth)
        .send({ type: 'love' });
      expect(bad.status).toBe(400);
      const moved = await supertest(ctx.app)
        .post(`/api/media/${dominionId}/reactions`)
        .set(auth)
        .send({ type: 'moved' });
      expect(moved.status).toBe(200);
      expect(moved.body).toEqual({
        stats: { saves: 0, moved: 1, acted: 0 },
        viewer: { saved: false, reactions: ['moved'] },
      });
      await supertest(ctx.app)
        .post(`/api/media/${dominionId}/reactions`)
        .set(auth)
        .send({ type: 'moved' });
      const acted = await supertest(ctx.app)
        .post(`/api/media/${dominionId}/reactions`)
        .set(auth)
        .send({ type: 'acted' });
      expect(acted.body.stats).toEqual({ saves: 0, moved: 1, acted: 1 });
      const off = await supertest(ctx.app)
        .delete(`/api/media/${dominionId}/reactions/moved`)
        .set(auth);
      expect(off.body).toEqual({
        stats: { saves: 0, moved: 0, acted: 1 },
        viewer: { saved: false, reactions: ['acted'] },
      });
    });
  });

  describe('admin', () => {
    it('creates, lists, edits and locks titles against ingest, and manages collections', async () => {
      const auth = bearer(admin.token);
      expect(
        (await supertest(ctx.app).get('/api/admin/media').set(bearer(member.token))).status,
      ).toBe(403);

      const created = await supertest(ctx.app)
        .post('/api/admin/media')
        .set(auth)
        .send({
          title: 'Dominion',
          kind: 'documentary',
          year: 2018,
          synopsis: 'Hand-written.',
          status: 'published',
          watchLinks: [{ provider: 'Site', url: 'https://example.test/s', access: 'free' }],
        });
      expect(created.status).toBe(201);
      // The slug never collides with the existing title.
      expect(created.body.media.slug).toBe('dominion-2018');
      expect(created.body.media.adminEdited).toContain('synopsis');

      const listed = await supertest(ctx.app)
        .get('/api/admin/media')
        .set(auth)
        .query({ status: 'draft' });
      expect(slugs(listed.body)).toEqual(['draft-film']);

      const draft = await MediaItemModel.findOne({ slug: 'draft-film' });
      const patched = await supertest(ctx.app)
        .patch(`/api/admin/media/${draft?._id}`)
        .set(auth)
        .send({ status: 'published', synopsis: 'Edited by hand.', tags: ['ethics', 'classic'] });
      expect(patched.status).toBe(200);
      expect(patched.body.media).toMatchObject({
        status: 'published',
        synopsis: 'Edited by hand.',
      });

      // An ingest run for the same (source, sourceId) may not overwrite the admin's synopsis.
      await MediaItemModel.updateOne(
        { _id: draft?._id },
        { $set: { source: 'curated', sourceId: 'Q1' } },
      );
      const result = await ingestItems(
        'media',
        'curated',
        [
          {
            sourceId: 'Q1',
            title: 'Draft Film',
            kind: 'film',
            synopsis: 'From the bot.',
            year: 2001,
          },
        ],
        { trusted: true },
      );
      expect(result.updated).toBe(1);
      const after = await MediaItemModel.findById(draft?._id).lean();
      expect(after?.synopsis).toBe('Edited by hand.');
      expect(after?.year).toBe(2001);

      const col = await supertest(ctx.app)
        .post('/api/admin/media/collections')
        .set(auth)
        .send({ name: 'For skeptics', itemIds: [dominionId], published: true });
      expect(col.status).toBe(201);
      expect(col.body.collection.slug).toBe('for-skeptics');
      const updated = await supertest(ctx.app)
        .patch(`/api/admin/media/collections/${col.body.collection.id}`)
        .set(auth)
        .send({ order: 0, description: 'Start with these.' });
      expect(updated.body.collection.order).toBe(0);
      const home = await supertest(ctx.app).get('/api/media/home');
      expect(home.body.rows[0].key).toBe('collection:for-skeptics');

      const gone = await supertest(ctx.app)
        .delete(`/api/admin/media/${created.body.media.id}`)
        .set(auth);
      expect(gone.status).toBe(204);
      expect((await supertest(ctx.app).get('/api/media/dominion-2018')).status).toBe(404);
    });
  });
});
