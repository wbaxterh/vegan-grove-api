import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { AREA_BOXES, areaForPoint, cityForArea } from '../src/lib/areas.js';
import { AppError } from '../src/lib/errors.js';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetFilter,
  keysetPage,
  keysetSort,
} from '../src/lib/keyset.js';
import { describePlace } from '../src/lib/placeDescription.js';
import { HOME_AREAS } from '../src/models/enums.js';

describe('areaForPoint', () => {
  // [name, lng, lat, area]: one well-known spot per area plus the edges that matter.
  const cases: Array<[string, number, number, string]> = [
    ['Santa Monica Pier', -118.4973, 34.0094, 'la_westside'],
    ['West Hollywood', -118.3617, 34.09, 'la_westside'],
    ['Silver Lake', -118.2705, 34.0869, 'la_eastside'],
    ['Glendale', -118.2551, 34.1425, 'la_eastside'],
    ['Highland Park', -118.19, 34.11, 'la_eastside'],
    ['Torrance', -118.3406, 33.8358, 'south_bay'],
    ['San Pedro', -118.2923, 33.7361, 'south_bay'],
    ['Downtown Long Beach', -118.1937, 33.7701, 'long_beach'],
    ['Lakewood', -118.1339, 33.8536, 'long_beach'],
    ['Pasadena', -118.1445, 34.1478, 'sgv'],
    ['Pomona', -117.7499, 34.0551, 'sgv'],
    ['Van Nuys', -118.4489, 34.1899, 'sfv'],
    ['Burbank', -118.3089, 34.1808, 'sfv'],
    ['Chatsworth', -118.6012, 34.2572, 'sfv'],
    ['Irvine', -117.8265, 33.6846, 'orange_county'],
    ['San Clemente', -117.6122, 33.4269, 'orange_county'],
    ['Seal Beach', -118.1048, 33.7414, 'orange_county'],
    ['Riverside', -117.3962, 33.9534, 'inland_empire'],
    ['Corona', -117.5664, 33.8753, 'inland_empire'],
    ['Temecula', -117.1484, 33.4936, 'inland_empire'],
    ['Downtown San Diego', -117.1611, 32.7157, 'san_diego'],
    ['Oceanside', -117.3795, 33.1959, 'san_diego'],
    ['Ventura', -119.2945, 34.2805, 'ventura'],
    ['Thousand Oaks', -118.8376, 34.1706, 'ventura'],
    ['Acton (Farm Sanctuary)', -118.2368, 34.5021, 'other'],
    ['Santa Clarita (Gentle Barn)', -118.4125, 34.464, 'other'],
    ['Bakersfield', -119.0187, 35.3733, 'other'],
    ['Watkins Glen, NY', -76.8733, 42.3806, 'other'],
  ];

  it.each(cases)('%s -> %s', (_name, lng, lat, area) => {
    expect(areaForPoint(lng, lat)).toBe(area);
  });

  it('only uses areas from the home-area enum and never returns undefined', () => {
    for (const box of AREA_BOXES) {
      expect(HOME_AREAS).toContain(box.area);
      expect(box.w).toBeLessThan(box.e);
      expect(box.s).toBeLessThan(box.n);
    }
    expect(areaForPoint(0, 0)).toBe('other');
    expect(areaForPoint(-180, -90)).toBe('other');
  });

  it('labels every area for the city fallback', () => {
    for (const area of HOME_AREAS) expect(cityForArea(area)).toMatch(/\S/);
    expect(cityForArea('long_beach')).toBe('Long Beach');
  });
});

describe('describePlace', () => {
  it('writes the sentence from the spec', () => {
    expect(
      describePlace({
        type: 'cafe',
        veganLevel: 'full',
        city: 'Long Beach',
        cuisine: ['thai', 'vegan'],
      }),
    ).toBe('Fully vegan cafe in Long Beach. Cuisine: thai, vegan.');
    expect(describePlace({ type: 'restaurant', veganLevel: 'options', city: 'Irvine' })).toBe(
      'Restaurant with vegan options in Irvine.',
    );
    expect(describePlace({ type: 'sanctuary', veganLevel: 'full', city: 'Acton' })).toBe(
      'Animal sanctuary in Acton.',
    );
    expect(describePlace({ type: 'garden', veganLevel: 'full', city: '' })).toBe(
      'Community garden.',
    );
  });
});

describe('keyset cursor', () => {
  const fields = [
    { field: 'veganLevel', direction: 1 as const },
    { field: 'reviewCount', direction: -1 as const },
  ];

  it('round-trips sort values and the id through an opaque string', () => {
    const row = { _id: new Types.ObjectId(), veganLevel: 'full', reviewCount: 3, name: 'x' };
    const cursor = encodeKeysetCursor(row, fields);
    expect(cursor).not.toContain('full');
    const decoded = decodeKeysetCursor(cursor, fields);
    expect(decoded?.values).toEqual(['full', 3]);
    expect(decoded?.id.equals(row._id)).toBe(true);
    expect(decodeKeysetCursor(undefined, fields)).toBeNull();
  });

  it('keeps dates as dates', () => {
    const dateFields = [{ field: 'startsAt', direction: 1 as const }];
    const startsAt = new Date('2026-10-24T17:00:00.000Z');
    const cursor = encodeKeysetCursor({ _id: new Types.ObjectId(), startsAt }, dateFields);
    expect(decodeKeysetCursor(cursor, dateFields)?.values[0]).toEqual(startsAt);
  });

  it('builds the strictly-after filter with _id as the final tiebreaker', () => {
    const id = new Types.ObjectId();
    const cursor = encodeKeysetCursor({ _id: id, veganLevel: 'full', reviewCount: 3 }, fields);
    expect(keysetFilter(fields, cursor)).toEqual({
      $or: [
        { veganLevel: { $gt: 'full' } },
        { veganLevel: 'full', reviewCount: { $lt: 3 } },
        { veganLevel: 'full', reviewCount: 3, _id: { $gt: id } },
      ],
    });
    expect(keysetFilter(fields, undefined)).toEqual({});
    expect(keysetSort(fields)).toEqual({ veganLevel: 1, reviewCount: -1, _id: 1 });
    expect(keysetSort([{ field: '_id', direction: -1 }])).toEqual({ _id: -1 });
  });

  it('rejects cursors that were not produced for this sort', () => {
    const other = encodeKeysetCursor({ _id: new Types.ObjectId(), a: 1 }, [
      { field: 'a', direction: 1 },
    ]);
    expect(() => decodeKeysetCursor(other, fields)).toThrow(AppError);
    expect(() => decodeKeysetCursor('!!!', fields)).toThrow(AppError);
    expect(() =>
      decodeKeysetCursor(Buffer.from('[{"x":1},"zz"]').toString('base64url'), [
        { field: 'a', direction: 1 },
      ]),
    ).toThrow(AppError);
  });

  it('splits limit+1 rows into a page and the continuation cursor', () => {
    const rows = [1, 2, 3].map((n) => ({
      _id: new Types.ObjectId(),
      veganLevel: 'full',
      reviewCount: n,
    }));
    const page = keysetPage(rows, 2, fields);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(encodeKeysetCursor(rows[1] as (typeof rows)[number], fields));
    expect(keysetPage(rows.slice(0, 2), 2, fields).nextCursor).toBeNull();
  });
});
