import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EventModel,
  GuideModel,
  MediaItemModel,
  OrganizationModel,
  PlaceModel,
} from '../src/models/index.js';
import {
  bearer,
  createTestContext,
  promoteToAdmin,
  registerUser,
  type TestContext,
} from './helpers/app.js';

const KEY = 'test-ingest-key-0123456789abcdef';
const withKey = { 'X-Ingest-Key': KEY };

const place = (sourceId: string, extra: Record<string, unknown> = {}) => ({
  sourceId,
  name: `Place ${sourceId}`,
  type: 'restaurant',
  veganLevel: 'full',
  location: { lng: -118.19, lat: 33.77 },
  ...extra,
});

const event = (sourceId: string, extra: Record<string, unknown> = {}) => ({
  sourceId,
  title: `Event ${sourceId}`,
  type: 'sanctuary_day',
  startsAt: '2026-11-21T18:00:00-08:00',
  hostName: 'Animal Place',
  sourceUrl: 'https://animalplace.org/event/example/',
  ...extra,
});

describe('POST /api/ingest/:resource', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ INGEST_KEY: KEY, TRUSTED_SOURCES: 'curated,osm' });
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('auth', () => {
    it('answers 401 without a key or with a wrong key, and to members', async () => {
      const anon = await supertest(ctx.app)
        .post('/api/ingest/places')
        .send({ source: 'osm', items: [place('a')] });
      expect(anon.status).toBe(401);
      expect(anon.body.error.code).toBe('unauthenticated');

      const wrong = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set('X-Ingest-Key', 'nope')
        .send({ source: 'osm', items: [place('a')] });
      expect(wrong.status).toBe(401);

      const { token } = await registerUser(ctx.app);
      const member = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(bearer(token))
        .send({ source: 'osm', items: [place('a')] });
      expect(member.status).toBe(403);
      expect(await PlaceModel.countDocuments()).toBe(0);
    });

    it('answers 503 ingest_unconfigured until INGEST_KEY exists', async () => {
      const app = ctx.buildApp({ INGEST_KEY: undefined });
      const res = await supertest(app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'osm', items: [place('a')] });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('ingest_unconfigured');
    });

    it('lets an admin session call it', async () => {
      const { token, id } = await registerUser(ctx.app);
      await promoteToAdmin(id);
      const res = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(bearer(token))
        .send({ source: 'bot:test', items: [place('a')] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ inserted: 1, updated: 0, unchanged: 0, rejected: [] });
    });

    it('rate limits per key with a Retry-After header', async () => {
      const app = ctx.buildApp({ RATE_LIMIT_INGEST_MAX: '2' });
      const send = () =>
        supertest(app)
          .post('/api/ingest/places')
          .set(withKey)
          .send({ source: 'osm', items: [place('rl')] });
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      const third = await send();
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('rate_limited');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('envelope', () => {
    it('answers 400 for a bad resource, a missing source, or too many items', async () => {
      const resource = await supertest(ctx.app)
        .post('/api/ingest/users')
        .set(withKey)
        .send({ source: 'osm', items: [place('a')] });
      expect(resource.status).toBe(400);

      const noSource = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ items: [place('a')] });
      expect(noSource.status).toBe(400);
      expect(noSource.body.error.code).toBe('validation_error');

      const tooMany = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'osm', items: Array.from({ length: 201 }, (_, i) => place(`p${i}`)) });
      expect(tooMany.status).toBe(400);
      expect(await PlaceModel.countDocuments()).toBe(0);
    });
  });

  describe('places', () => {
    it('gives 207 with per-item errors for a mixed batch and still writes the good ones', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({
          source: 'bot:test',
          items: [
            place('ok', { city: 'Long Beach', tags: ['thai'] }),
            { sourceId: 'bad', name: 'No type' },
            place('personal', { email: 'owner@example.org' }),
            place('ok'),
            { name: 'no id', type: 'cafe', veganLevel: 'full', location: { lng: 0, lat: 0 } },
          ],
        });
      expect(res.status).toBe(207);
      expect(res.body.inserted).toBe(1);
      expect(res.body.rejected).toHaveLength(4);
      expect(res.body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 2, 3, 4]);
      expect(res.body.rejected[0]).toMatchObject({ sourceId: 'bad' });
      expect(res.body.rejected[0].errors.join(' ')).toMatch(/type/);
      expect(res.body.rejected[1].errors).toEqual(['email: personal data is not accepted']);
      expect(res.body.rejected[2].errors).toEqual(['sourceId: duplicated within this batch']);
      expect(res.body.rejected[3].sourceId).toBeNull();

      const stored = await PlaceModel.findOne({ source: 'bot:test', sourceId: 'ok' }).lean();
      expect(stored).toMatchObject({
        slug: 'place-ok',
        approvalStatus: 'pending',
        area: 'long_beach',
        city: 'Long Beach',
        chain: false,
        description: 'Fully vegan restaurant in Long Beach.',
        adminEdited: [],
      });
      expect(stored?.lastSeenAt).toBeInstanceOf(Date);
    });

    it('answers 207 when every item is rejected', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'bot:test', items: [{ sourceId: 'x' }] });
      expect(res.status).toBe(207);
      expect(res.body.inserted).toBe(0);
    });

    it('derives area and city from the coordinates, never from the text', async () => {
      await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({
          source: 'bot:test',
          items: [
            place('sm', { location: { lng: -118.4973, lat: 34.0094 }, city: 'Long Beach' }),
            place('nocity', { location: { lng: -117.8265, lat: 33.6846 } }),
            place('sanct', { type: 'sanctuary', veganLevel: 'options' }),
          ],
        });
      const rows = await PlaceModel.find({ source: 'bot:test' }).sort({ sourceId: 1 }).lean();
      expect(rows.map((r) => [r.sourceId, r.area, r.city, r.veganLevel])).toEqual([
        ['nocity', 'orange_county', 'Orange County', 'full'],
        ['sanct', 'long_beach', 'Long Beach', 'full'],
        ['sm', 'la_westside', 'Long Beach', 'full'],
      ]);
    });

    it('re-ingest is unchanged but bumps lastSeenAt; a changed field counts as updated', async () => {
      const items = [place('a', { hours: 'Mo-Su 10:00-20:00' }), place('b')];
      const first = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'osm', items });
      expect(first.body).toMatchObject({ inserted: 2, updated: 0, unchanged: 0 });
      const before = await PlaceModel.findOne({ source: 'osm', sourceId: 'a' }).lean();

      await new Promise((r) => setTimeout(r, 5));
      const second = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'osm', items });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
      const after = await PlaceModel.findOne({ source: 'osm', sourceId: 'a' }).lean();
      expect(after?.slug).toBe(before?.slug);
      expect(after?.lastSeenAt?.getTime()).toBeGreaterThan(before?.lastSeenAt?.getTime() ?? 0);

      const third = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'osm', items: [place('a', { hours: 'Mo-Su 11:00-21:00' }), place('b')] });
      expect(third.body).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
      expect(await PlaceModel.countDocuments({ source: 'osm' })).toBe(2);
    });

    it('trusted sources land approved and promote pending rows, never rejected ones', async () => {
      const untrusted = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'bot:test', items: [place('u')] });
      expect(untrusted.status).toBe(200);
      expect((await PlaceModel.findOne({ sourceId: 'u' }))?.approvalStatus).toBe('pending');

      const trusted = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'curated', items: [place('t'), place('r')] });
      expect(trusted.status).toBe(200);
      expect((await PlaceModel.findOne({ sourceId: 't' }))?.approvalStatus).toBe('approved');

      // `t` was imported before the source was trusted; `r` was rejected by an admin.
      await PlaceModel.updateOne({ sourceId: 't' }, { $set: { approvalStatus: 'pending' } });
      await PlaceModel.updateOne(
        { sourceId: 'r' },
        { $set: { approvalStatus: 'rejected', adminEdited: ['approvalStatus'] } },
      );
      const again = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'curated', items: [place('t'), place('r')] });
      expect(again.body).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
      expect((await PlaceModel.findOne({ sourceId: 't' }))?.approvalStatus).toBe('approved');
      expect((await PlaceModel.findOne({ sourceId: 'r' }))?.approvalStatus).toBe('rejected');
    });

    it('never overwrites a field an admin edited', async () => {
      await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({ source: 'osm', items: [place('e', { hours: 'Mo-Fr 09:00-17:00' })] });
      await PlaceModel.updateOne(
        { source: 'osm', sourceId: 'e' },
        { $set: { name: 'Admin Name', adminEdited: ['name'] } },
      );

      const res = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({
          source: 'osm',
          items: [place('e', { name: 'Source Name', hours: 'Mo-Fr 10:00-18:00' })],
        });
      expect(res.body).toMatchObject({ updated: 1 });
      const row = await PlaceModel.findOne({ source: 'osm', sourceId: 'e' }).lean();
      expect(row?.name).toBe('Admin Name');
      expect(row?.hours).toBe('Mo-Fr 10:00-18:00');

      const same = await supertest(ctx.app)
        .post('/api/ingest/places')
        .set(withKey)
        .send({
          source: 'osm',
          items: [place('e', { name: 'Source Name', hours: 'Mo-Fr 10:00-18:00' })],
        });
      expect(same.body).toMatchObject({ updated: 0, unchanged: 1 });
    });
  });

  describe('events and organizations', () => {
    it('creates an unverified host org, defaults endsAt, and rejects personal fields', async () => {
      const res = await supertest(ctx.app)
        .post('/api/ingest/events')
        .set(withKey)
        .send({
          source: 'ics:animalplace',
          items: [
            event('tour-1', { location: { lng: -118.19, lat: 33.77 } }),
            event('tour-2', { phone: '555-0100' }),
            event('tour-3', { attendees: ['someone'] }),
            event('tour-4', { startsAt: '2026-11-21T18:00:00' }),
            event('tour-5', { endsAt: '2026-11-21T17:00:00-08:00' }),
          ],
        });
      expect(res.status).toBe(207);
      expect(res.body.inserted).toBe(1);
      expect(res.body.rejected.map((r: { sourceId: string }) => r.sourceId)).toEqual([
        'tour-2',
        'tour-3',
        'tour-4',
        'tour-5',
      ]);
      expect(res.body.rejected[0].errors).toEqual(['phone: personal data is not accepted']);

      const org = await OrganizationModel.findOne({ slug: 'animal-place' }).lean();
      expect(org).toMatchObject({
        name: 'Animal Place',
        type: 'org',
        verified: false,
        source: 'ics:animalplace',
        sourceId: 'host:animal-place',
      });
      const stored = await EventModel.findOne({ sourceId: 'tour-1' }).lean();
      expect(stored).toMatchObject({
        status: 'pending',
        hostType: 'organization',
        hostModel: 'Organization',
        area: 'long_beach',
        visibility: 'public',
      });
      expect(stored?.hostId.equals(org?._id)).toBe(true);
      expect(stored?.startsAt.toISOString()).toBe('2026-11-22T02:00:00.000Z');
      expect(stored?.endsAt.toISOString()).toBe('2026-11-22T04:00:00.000Z');
      expect(stored?.createdBy).toBeUndefined();
    });

    it('lets a curated organization adopt the host stub instead of duplicating it', async () => {
      await supertest(ctx.app)
        .post('/api/ingest/events')
        .set(withKey)
        .send({ source: 'ics:animalplace', items: [event('t')] });
      const stub = await OrganizationModel.findOne({ slug: 'animal-place' }).lean();

      const res = await supertest(ctx.app)
        .post('/api/ingest/organizations')
        .set(withKey)
        .send({
          source: 'curated',
          items: [
            {
              sourceId: 'animal-place',
              name: 'Animal Place',
              type: 'sanctuary',
              website: 'https://animalplace.org/',
              socials: { instagram: 'animalplace' },
              area: 'other',
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ inserted: 0, updated: 1 });
      expect(await OrganizationModel.countDocuments({ slug: 'animal-place' })).toBe(1);
      const adopted = await OrganizationModel.findOne({ slug: 'animal-place' }).lean();
      expect(adopted?._id.equals(stub?._id)).toBe(true);
      expect(adopted).toMatchObject({
        type: 'sanctuary',
        verified: true,
        source: 'curated',
        sourceId: 'animal-place',
        website: 'https://animalplace.org/',
        socials: { instagram: 'animalplace' },
      });
      expect(adopted?.adminUserIds).toEqual([]);
    });
  });

  describe('media and guides', () => {
    it('accepts media without a poster and guides only with sources', async () => {
      const media = await supertest(ctx.app)
        .post('/api/ingest/media')
        .set(withKey)
        .send({
          source: 'wikidata',
          items: [
            {
              sourceId: 'Q17049022',
              title: 'Cowspiracy: The Sustainability Secret',
              kind: 'documentary',
              year: 2014,
              externalIds: { wikidata: 'Q17049022', imdb: 'tt3302820' },
            },
            { sourceId: 'Q1', title: 'Bad poster', kind: 'film', posterKey: '../etc/passwd' },
          ],
        });
      expect(media.status).toBe(207);
      expect(media.body.inserted).toBe(1);
      const row = await MediaItemModel.findOne({ sourceId: 'Q17049022' }).lean();
      expect(row).toMatchObject({
        slug: 'cowspiracy-the-sustainability-secret-2014',
        status: 'draft',
        externalIds: { wikidata: 'Q17049022', imdb: 'tt3302820' },
      });

      // Enrichment re-sends under the same source and sourceId, so it lands on the same row.
      const enrich = await supertest(ctx.app)
        .post('/api/ingest/media')
        .set(withKey)
        .send({
          source: 'wikidata',
          items: [
            {
              sourceId: 'Q17049022',
              title: 'Cowspiracy: The Sustainability Secret',
              kind: 'documentary',
              year: 2014,
              posterKey: 'media/posters/263005.jpg',
              tags: ['Watch providers data by JustWatch'],
              externalIds: { tmdb: '263005' },
            },
          ],
        });
      expect(enrich.body).toMatchObject({ updated: 1 });
      expect(await MediaItemModel.countDocuments()).toBe(1);
      expect((await MediaItemModel.findOne({ sourceId: 'Q17049022' }).lean())?.posterKey).toBe(
        'media/posters/263005.jpg',
      );

      const guides = await supertest(ctx.app)
        .post('/api/ingest/guides')
        .set(withKey)
        .send({
          source: 'bot:grokbot',
          items: [
            {
              sourceId: 'first-visit',
              title: 'Your first sanctuary visit',
              category: 'sanctuary',
              body: '# Go\n\nBook a tour.',
              sources: [{ title: 'Farm Sanctuary visits', url: 'https://www.farmsanctuary.org/' }],
            },
            { sourceId: 'no-sources', title: 'x', category: 'other', body: 'y' },
          ],
        });
      expect(guides.status).toBe(207);
      expect(guides.body.inserted).toBe(1);
      expect((await GuideModel.findOne({ sourceId: 'first-visit' }))?.status).toBe('draft');
    });
  });
});
