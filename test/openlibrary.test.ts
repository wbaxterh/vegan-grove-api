import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripJpegMetadata } from '../scripts/ingest/lib/jpeg.js';
import {
  attachCovers,
  coverFetchUrl,
  coverObjectKey,
  createPacer,
  docToMapped,
  downloadCover,
  mergeSubjects,
  OPEN_LIBRARY_USER_AGENT,
  type OpenLibraryDoc,
  pickIsbn,
  searchSubject,
  searchUrl,
} from '../scripts/ingest/media-openlibrary.js';
import type { MediaItemInput } from '../src/services/ingest.js';
import { mediaItemSchema } from '../src/services/ingest.js';

const ISBN_13 = '9781845434168';
const ISBN_10 = '1845434161';

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function jpegWithExif(padBytes = 800): Buffer {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from('GPS:34.05,-118.24')]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0', 'binary')),
    segment(0xe1, exif),
    segment(0xed, Buffer.from('Photoshop 3.0', 'binary')),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(padBytes, 0x11),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function book(id: string, extra: Partial<MediaItemInput> = {}): MediaItemInput {
  return {
    sourceId: id,
    title: `Title ${id}`,
    kind: 'book',
    tags: ['open-library', 'veganism'],
    externalIds: { openLibrary: id },
    sourceUrl: `https://openlibrary.org/works/${id}`,
    ...extra,
  };
}

describe('Open Library mapping', () => {
  it('maps a work to a book with authors, year, ISBN, and an outbound link', () => {
    const mapped = docToMapped(
      {
        key: '/works/OL24340920W',
        title: '  500 Vegan Dishes ',
        author_name: ['Deborah Gray', 'Deborah Gray', 'Sellers Publishing'],
        first_publish_year: 2011,
        isbn: [ISBN_10, ISBN_13, '9780000000001'],
        cover_i: 10864115,
      },
      'veganism',
    );
    expect(mapped?.coverId).toBe(10864115);
    expect(mapped?.item).toEqual({
      sourceId: 'OL24340920W',
      title: '500 Vegan Dishes',
      kind: 'book',
      year: 2011,
      authors: ['Deborah Gray', 'Sellers Publishing'],
      tags: ['open-library', 'veganism'],
      externalIds: { openLibrary: 'OL24340920W', isbn: ISBN_13 },
      sourceUrl: 'https://openlibrary.org/works/OL24340920W',
    });
    expect(JSON.stringify(mapped)).not.toContain('covers.openlibrary.org');
    expect(mapped?.item).not.toHaveProperty('posterKey');
    expect(mediaItemSchema.safeParse(mapped?.item).success).toBe(true);
  });

  it('keeps a pre-1900 year, drops a year the catalogue cannot store, and skips non-works', () => {
    const old = docToMapped(
      { key: 'OL10W', title: 'A Vindication of the Rights of Brutes', first_publish_year: 1792 },
      'animal-rights',
    );
    expect(old?.item.year).toBe(1792);
    expect(mediaItemSchema.safeParse(old?.item).success).toBe(true);
    expect(mediaItemSchema.safeParse({ ...old?.item, year: 999 }).success).toBe(false);

    const ancient = docToMapped(
      { key: 'OL11W', title: 'Fragment', first_publish_year: 12 },
      'veganism',
    );
    expect(ancient?.item).not.toHaveProperty('year');
    expect(docToMapped({ key: '/books/OL1M', title: 'Edition' }, 'veganism')).toBeNull();
    expect(docToMapped({ key: '/works/OL1W' }, 'veganism')).toBeNull();
  });

  it('prefers a valid ISBN-13 and ignores junk', () => {
    expect(pickIsbn([`978-1-84543-416-8`, ISBN_10])).toBe(ISBN_13);
    expect(pickIsbn([ISBN_10, 'not-an-isbn'])).toBe(ISBN_10);
    expect(pickIsbn(['9780000000001'])).toBeUndefined();
    expect(pickIsbn(undefined)).toBeUndefined();
  });

  it('merges a work found under both subjects and never stores a cover URL', () => {
    const veganism: OpenLibraryDoc = {
      key: '/works/OL10W',
      title: 'Zebra',
      author_name: ['A'],
    };
    const rights: OpenLibraryDoc = {
      key: 'OL10W',
      title: 'Zebra',
      cover_i: 4,
      isbn: [ISBN_13],
    };
    const books = mergeSubjects([
      { tag: 'veganism', docs: [veganism] },
      {
        tag: 'animal-rights',
        docs: [rights, { key: 'OL11W', title: 'Apple', author_name: ['B'] }],
      },
    ]);
    expect(books.map((entry) => entry.item.title)).toEqual(['Apple', 'Zebra']);
    expect(books[1]?.item.tags).toEqual(['open-library', 'veganism', 'animal-rights']);
    expect(books[1]?.coverId).toBe(4);
    expect(books[1]?.item.externalIds?.isbn).toBe(ISBN_13);
    expect(JSON.stringify(books)).not.toContain('covers.openlibrary.org');
    expect(
      mediaItemSchema.safeParse({
        ...books[0]?.item,
        posterKey: 'https://covers.openlibrary.org/b/id/1-L.jpg',
      }).success,
    ).toBe(false);
  });
});

describe('Open Library fetch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pages until the subject is exhausted and sends a descriptive User-Agent', async () => {
    const urls: string[] = [];
    const agents: string[] = [];
    const result = await searchSubject('subject:"animal rights"', {
      pageSize: 2,
      maxPages: 5,
      pace: async () => {},
      fetchImpl: async (url, init) => {
        urls.push(url);
        agents.push(new Headers(init?.headers).get('user-agent') ?? '');
        const offset = Number(new URL(url).searchParams.get('offset'));
        const docs =
          offset === 0
            ? [
                { key: '/works/OL1W', title: 'One' },
                { key: '/works/OL2W', title: 'Two' },
              ]
            : [{ key: '/works/OL3W', title: 'Three' }];
        return Response.json({ num_found: 3, docs });
      },
    });
    expect(result.truncated).toBe(false);
    expect(result.docs).toHaveLength(3);
    expect(agents).toEqual([OPEN_LIBRARY_USER_AGENT, OPEN_LIBRARY_USER_AGENT]);
    expect(new URL(urls[0] ?? searchUrl('x', 1, 0)).searchParams.get('q')).toBe(
      'subject:"animal rights"',
    );
    expect(urls.map((url) => new URL(url).searchParams.get('offset'))).toEqual(['0', '2']);
  });

  it('stops at the page cap and reports the subject as truncated', async () => {
    const result = await searchSubject('subject:veganism', {
      pageSize: 1,
      maxPages: 1,
      pace: async () => {},
      fetchImpl: async () => Response.json({ num_found: 5, docs: [{ key: 'OL1W', title: 'One' }] }),
    });
    expect(result.truncated).toBe(true);
    expect(result.docs).toHaveLength(1);
  });

  it('waits out a 429 and then reads the page', async () => {
    let calls = 0;
    const result = await searchSubject('subject:veganism', {
      maxPages: 1,
      pace: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1)
          return new Response('', { status: 429, headers: { 'retry-after': '0.001' } });
        return Response.json({ num_found: 1, docs: [{ key: 'OL1W', title: 'One' }] });
      },
    });
    expect(calls).toBe(2);
    expect(result.docs).toHaveLength(1);
  });

  it('spaces calls by one second', async () => {
    vi.useFakeTimers();
    const pace = createPacer(1000);
    const marks: number[] = [];
    const run = (async () => {
      for (let i = 0; i < 3; i++) {
        await pace();
        marks.push(Date.now());
      }
    })();
    await vi.runAllTimersAsync();
    await run;
    expect((marks[1] ?? 0) - (marks[0] ?? 0)).toBe(1000);
    expect((marks[2] ?? 0) - (marks[1] ?? 0)).toBe(1000);
  });
});

describe('Open Library covers', () => {
  it('strips EXIF and IPTC and keeps the image', () => {
    const raw = jpegWithExif(32);
    const stripped = stripJpegMetadata(raw);
    expect(stripped.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(stripped.includes(Buffer.from('JFIF'))).toBe(true);
    expect(stripped.includes(Buffer.from('Exif'))).toBe(false);
    expect(stripped.includes(Buffer.from('GPS:34.05'))).toBe(false);
    expect(stripped.includes(Buffer.from('Photoshop'))).toBe(false);
    expect(stripped.subarray(stripped.length - 2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(stripJpegMetadata(Buffer.from('not a jpeg'))).toEqual(Buffer.from('not a jpeg'));
  });

  it('re-hosts a cover and skips one already stored, a dry run, and a non-jpeg', async () => {
    const image = jpegWithExif();
    const fetches: string[] = [];
    const puts: Array<{ key: string; body: Buffer }> = [];
    const store = {
      async has(key: string) {
        return key === coverObjectKey('OL2W');
      },
      async put(key: string, body: Buffer) {
        puts.push({ key, body });
      },
    };
    const books = [
      { item: book('OL1W'), coverId: 55 },
      { item: book('OL2W'), coverId: 66 },
      { item: book('OL3W') },
    ];
    const items = await attachCovers(books, {
      dryRun: false,
      store,
      pace: async () => {},
      warn: () => {},
      fetchImpl: async (url, init) => {
        fetches.push(url);
        expect(new Headers(init?.headers).get('user-agent')).toBe(OPEN_LIBRARY_USER_AGENT);
        return new Response(new Uint8Array(image), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      },
    });
    expect(fetches).toEqual([coverFetchUrl(55)]);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe(coverObjectKey('OL1W'));
    expect(puts[0]?.body.includes(Buffer.from('Exif'))).toBe(false);
    expect(puts[0]?.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(items.map((item) => item.posterKey)).toEqual([
      coverObjectKey('OL1W'),
      coverObjectKey('OL2W'),
      undefined,
    ]);
    expect(JSON.stringify(items)).not.toContain('covers.openlibrary.org');

    let touched = false;
    const dry = await attachCovers([{ item: book('OL9W'), coverId: 1 }], {
      dryRun: true,
      store,
      pace: async () => {
        touched = true;
      },
      warn: () => {},
      fetchImpl: async () => {
        touched = true;
        return new Response(null, { status: 500 });
      },
    });
    expect(touched).toBe(false);
    expect(dry[0]?.posterKey).toBe(coverObjectKey('OL9W'));

    const warnings: string[] = [];
    const skipped = await attachCovers([{ item: book('OL8W'), coverId: 9 }], {
      dryRun: false,
      store: null,
      pace: async () => {},
      warn: (_obj, msg) => warnings.push(msg),
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(skipped[0]?.posterKey).toBeUndefined();
    expect(warnings).toEqual(['S3_MEDIA_BUCKET not set; covers skipped']);

    const rejected = await downloadCover(
      coverFetchUrl(1),
      async () => new Response(new Uint8Array(Buffer.alloc(800, 1)), { status: 200 }),
    );
    expect(rejected).toBeNull();
  });
});
