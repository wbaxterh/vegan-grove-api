import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOverpassTiled, tileBbox } from '../scripts/lib/osm.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

/** Two tiles: 0.5 degrees of latitude by one tile of longitude. */
const BBOX = '33.0,-118.0,33.5,-117.75';

function jsonResponse(elements: unknown[]): Response {
  return new Response(JSON.stringify({ elements }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchOverpassTiled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('splits the box into tiles', () => {
    expect(tileBbox(BBOX)).toHaveLength(2);
  });

  it('skips a tile both mirrors give up on and keeps the rest', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const query = decodeURIComponent(new URL(url).searchParams.get('data') ?? '');
        seen.push(url);
        // The northern tile answers; the southern one is a gateway timeout every time.
        if (query.includes('33.25,-118,33.5,-117.75')) {
          return jsonResponse([{ type: 'node', id: 1, lat: 33.3, lon: -117.9, tags: {} }]);
        }
        return new Response('', { status: 504 });
      }),
    );
    const pending = fetchOverpassTiled(
      'https://primary.test/api',
      (bbox) => `q(${bbox})`,
      logger,
      BBOX,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.elements.map((e) => e.id)).toEqual([1]);
    expect(result.failedTiles).toEqual(['33,-118,33.25,-117.75']);
    // Two attempts on the primary mirror, then two on the fallback, for the bad tile only.
    expect(seen.filter((u) => u.startsWith('https://primary.test')).length).toBe(3);
    expect(seen.filter((u) => u.startsWith('https://overpass-api.de')).length).toBe(2);
  });

  it('fails only when no tile answered at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 504 })),
    );
    const pending = fetchOverpassTiled('https://primary.test/api', (bbox) => bbox, logger, BBOX);
    const outcome = pending.then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toContain('no tile at all');
  });
  it('gives up early when the service is down instead of grinding through every tile', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);
    // A 2 by 8 degree box is 64 tiles; the run must stop after the sixth consecutive failure.
    const pending = fetchOverpassTiled(
      'https://primary.test/api',
      (bbox) => bbox,
      logger,
      '32,-120,34,-112',
    );
    const outcome = pending.then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toContain('not answering');
    // Six tiles, four requests each (two per mirror): nothing beyond that.
    expect(fetchMock).toHaveBeenCalledTimes(24);
  });
});
