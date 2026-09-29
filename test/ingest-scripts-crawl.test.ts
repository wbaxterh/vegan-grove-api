import { describe, expect, it } from 'vitest';
import { collectDetailLinks, extractJsonLdEvents } from '../scripts/ingest/events-jsonld.js';
import { readBatches } from '../scripts/ingest/media-tmdb.js';
import { seedToMediaItems } from '../scripts/ingest/media-wikidata.js';
import { tileBbox } from '../scripts/lib/osm.js';
import { mediaItemSchema } from '../src/services/ingest.js';

describe('detail-page crawling', () => {
  const list = `<a href="/new-events/2021/11/20/thanksliving">old</a>
<a href="/new-events/2021/11/20/thanksliving?format=ical">ical</a>
<a href="/new-events/2099/1/26/tour">tour</a>
<a href="https://www.kindredspiritscarefarm.org/new-events/2099/2/2/potluck">potluck</a>
<a href="https://www.kindredspiritscarefarm.org/new-events/2099/2/2/potluck">dup</a>
<a href="https://elsewhere.example/new-events/2099/3/3/x">other origin</a>
<a href="/about">about</a>`;

  it('keeps same-origin links matching the pattern, without queries, stale dates or duplicates', () => {
    const links = collectDetailLinks(
      list,
      'https://www.kindredspiritscarefarm.org/new-events',
      String.raw`^/new-events/\d{4}/\d{1,2}/\d{1,2}/`,
      new Date('2026-09-29T00:00:00Z'),
    );
    expect(links).toEqual([
      'https://www.kindredspiritscarefarm.org/new-events/2099/1/26/tour',
      'https://www.kindredspiritscarefarm.org/new-events/2099/2/2/potluck',
    ]);
  });

  it('drops events that ended more than a day ago', () => {
    const html =
      '<script type="application/ld+json">{"@type":"Event","name":"Old","startDate":"2020-01-01T10:00:00-08:00"}</script>';
    expect(
      extractJsonLdEvents(html, 'https://x.org/', { source: 'jsonld:x', hostName: 'X' }),
    ).toEqual([]);
  });
});

describe('curated media seed', () => {
  it('maps seed entries with the Q-id as sourceId and documentary as the default kind', () => {
    const items = seedToMediaItems([
      { title: 'Earthlings', year: 2005, wikidata: 'Q1277684', imdb: 'tt0358456', tmdb: 30238 },
      { title: 'Okja', year: 2017, kind: 'film', wikidata: 'Q28129034' },
      { title: 'Unknown Talk', tags: ['talk'] },
      { title: '   ' },
    ]);
    expect(items.map((i) => [i.sourceId, i.kind, i.externalIds?.tmdb])).toEqual([
      ['Q1277684', 'documentary', '30238'],
      ['Q28129034', 'film', undefined],
      ['unknown-talk', 'documentary', undefined],
    ]);
    expect(items[0]?.tags).toEqual(['curated']);
    for (const item of items) expect(mediaItemSchema.safeParse(item).success).toBe(true);
  });

  it('reads every input shape the TMDB step accepts', () => {
    const seed = [{ title: 'Earthlings', wikidata: 'Q1277684', tmdb: 30238 }];
    expect(readBatches(seed)[0]).toMatchObject({ source: 'curated' });
    expect(readBatches({ source: 'wikidata', items: [] })).toEqual([
      { source: 'wikidata', items: [] },
    ]);
    expect(readBatches({ batches: [{ source: 'curated', items: [] }] })).toHaveLength(1);
    expect(() => readBatches({ nope: true })).toThrow(/input must be/);
  });
});

describe('overpass tiling', () => {
  it('covers the box with tiles no larger than the requested size', () => {
    const tiles = tileBbox('32.5,-119.5,34.9,-116.0', 0.25);
    expect(tiles).toHaveLength(10 * 14);
    expect(tiles[0]).toBe('32.5,-119.5,32.75,-119.25');
    expect(tiles[tiles.length - 1]).toBe('34.75,-116.25,34.9,-116');
    expect(tileBbox('0,0,1,1', 1)).toEqual(['0,0,1,1']);
  });
});
