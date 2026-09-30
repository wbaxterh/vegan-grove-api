import { describe, expect, it, vi } from 'vitest';
import allowlist from '../scripts/data/event-sources.json' with { type: 'json' };
import { dxeEventsUrl, dxeToEventItems } from '../scripts/ingest/events-dxe.js';
import { icsToEventItems, looksLikeCalendar } from '../scripts/ingest/events-ics.js';
import {
  isCalifornia,
  mapperFor,
  parseClockTime,
  seaShepherdToEventItems,
} from '../scripts/ingest/events-json.js';
import {
  collectDetailLinks,
  detailPageLimit,
  extractJsonLdEvents,
} from '../scripts/ingest/events-jsonld.js';
import {
  mobilizeEventsUrl,
  mobilizeNextUrl,
  mobilizeToEventItems,
} from '../scripts/ingest/events-mobilize.js';
import {
  tribePageUrl,
  tribeToEventItems,
  tribeTotalPages,
} from '../scripts/ingest/events-tribe.js';
import { inferEventType, pointOf, zoneOrDefault } from '../scripts/ingest/lib/events.js';
import { paceHost } from '../scripts/ingest/lib/http.js';
import {
  type EventSource,
  keepsTitle,
  kindOf,
  selectSources,
} from '../scripts/ingest/lib/sources.js';
import { type EventItem, eventItemSchema } from '../src/services/ingest.js';

const NOW = new Date('2026-10-01T00:00:00-07:00');
const ITEM_KEYS = new Set([
  'sourceId',
  'title',
  'type',
  'startsAt',
  'endsAt',
  'venueName',
  'address',
  'location',
  'hostName',
  'description',
  'sourceUrl',
]);

/** Every item passes the API schema and carries only the contract's keys. */
function expectAccepted(items: EventItem[]): void {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    const result = eventItemSchema.safeParse(item);
    expect(result.success, `${item.sourceId}: ${result.error?.message ?? ''}`).toBe(true);
    for (const key of Object.keys(item)) expect(ITEM_KEYS.has(key), key).toBe(true);
  }
}

/** None of the strings a source must never leak appears anywhere in the mapped output. */
function expectNever(items: unknown, ...needles: string[]): void {
  const text = JSON.stringify(items);
  for (const needle of needles) expect(text, needle).not.toContain(needle);
}

describe('allowlist fields', () => {
  it('routes by kind, inferring it for the round-1 entries', () => {
    expect(kindOf({ source: 'a', hostName: 'A', ics: 'https://a.org/?ical=1' })).toBe('ics');
    expect(kindOf({ source: 'b', hostName: 'B', url: 'https://b.org/events' })).toBe('jsonld');
    expect(
      kindOf({ source: 'c', hostName: 'C', kind: 'tribe', url: 'https://c.org/wp-json' }),
    ).toBe('tribe');
    expect(kindOf({ source: 'd', hostName: 'D' })).toBeUndefined();
  });

  it('skips disabled and placeholder entries with a reason, per kind', () => {
    const all: EventSource[] = [
      { source: 'jsonld:on', hostName: 'On', url: 'https://on.org/' },
      { source: 'jsonld:off', hostName: 'Off', url: 'https://off.org/', enabled: false },
      { source: 'jsonld:soon', hostName: 'Soon', url: 'https://soon.org/', placeholder: 'later' },
      { source: 'ics:feed', hostName: 'Feed', ics: 'https://feed.org/?ical=1' },
      { source: 'tribe:x', hostName: 'X', kind: 'tribe', url: 'https://x.org/wp-json' },
    ];
    const jsonld = selectSources(all, 'jsonld');
    expect(jsonld.selected.map((s) => s.source)).toEqual(['jsonld:on']);
    expect(jsonld.skipped).toEqual([
      { source: 'jsonld:off', reason: 'disabled' },
      { source: 'jsonld:soon', reason: 'placeholder' },
    ]);
    expect(selectSources(all, 'ics').selected.map((s) => s.source)).toEqual(['ics:feed']);
    expect(selectSources(all, 'tribe').selected.map((s) => s.source)).toEqual(['tribe:x']);
    expect(selectSources(all, 'mobilize')).toEqual({ selected: [], skipped: [] });
  });

  it('applies a case-insensitive titleFilter and lets everything through without one', () => {
    const src: EventSource = { source: 'x', hostName: 'X', titleFilter: 'vegfest|vegan' };
    expect(keepsTitle(src, 'San Diego VegFest')).toBe(true);
    expect(keepsTitle(src, 'The Nsefu Monkey Motorcycle Run')).toBe(false);
    expect(keepsTitle({ source: 'y', hostName: 'Y' }, 'Anything')).toBe(true);
  });

  it('falls back to defaultType before other', () => {
    expect(inferEventType('Banner drop', { defaultType: 'protest' })).toBe('protest');
    expect(inferEventType('Banner drop', {})).toBe('other');
    expect(inferEventType('Slaughterhouse vigil', { defaultType: 'protest' })).toBe('vigil');
  });

  describe('event-sources.json', () => {
    const sources = allowlist as unknown as EventSource[];
    const ofKind = (kind: string) => sources.filter((s) => kindOf(s) === kind);

    it('has unique ids, a host and a kind on every entry, and a note on every parked one', () => {
      expect(new Set(sources.map((s) => s.source)).size).toBe(sources.length);
      for (const src of sources) {
        expect(src.hostName, src.source).toBeTruthy();
        expect(kindOf(src), src.source).toBeDefined();
        expect(() => keepsTitle(src, ''), src.source).not.toThrow();
      }
      for (const src of sources.filter((s) => s.enabled === false)) {
        expect(src.decision ?? src.placeholder, src.source).toBeTruthy();
      }
      for (const src of sources.filter((s) => s.maxPages !== undefined)) {
        expect(src.maxPages, src.source).toBeLessThanOrEqual(50);
      }
    });

    it('parks every DxE chapter and points it at the org events page', () => {
      expect(ofKind('dxe')).toHaveLength(4);
      for (const src of ofKind('dxe')) {
        expect(src.enabled, src.source).toBe(false);
        expect(String(src.pageId)).toMatch(/^\d+$/);
        expect(src.sourceUrl).toMatch(/^https:\/\/www\.directactioneverywhere\.com\//);
      }
    });

    it('shapes the Mobilize, Tribe and JSON entries for their scripts', () => {
      expect(ofKind('mobilize').map((s) => s.organizationId)).toEqual([26695]);
      expect(ofKind('tribe').map((s) => s.url)).toEqual([
        'https://plantbasedtreaty.org/wp-json/tribe/events/v1/events',
      ]);
      for (const src of ofKind('json')) expect(() => mapperFor(src.mapping)).not.toThrow();
    });

    it('activates the ready JSON-LD sources and parks the ones awaiting a decision', () => {
      const ready = selectSources(sources, 'jsonld').selected.map((s) => s.source);
      expect(ready).toEqual([
        'jsonld:kindredspirits',
        'jsonld:openbarn',
        'jsonld:marthasfarm',
        'jsonld:pebbleranch',
        'jsonld:animalrightscalendar-la',
        'jsonld:animalrightscalendar-sd',
      ]);
      expect(selectSources(sources, 'jsonld').skipped.map((s) => s.source)).toEqual([
        'jsonld:farmsanctuary',
        'jsonld:gentlebarn',
        'jsonld:ourhonor',
        'jsonld:veganstreetfair-eventeny',
        'jsonld:nsefu-sdvegfest',
      ]);
      expect(selectSources(sources, 'ics').selected.map((s) => s.source)).toEqual([
        'ics:saleranch',
      ]);
    });
  });
});

describe('script fixes', () => {
  const SRC: EventSource = { source: 'ics:pbt', hostName: 'Plant Based Treaty' };

  it('treats an empty or non-calendar ICS body as no events instead of throwing', () => {
    expect(looksLikeCalendar('')).toBe(false);
    expect(looksLikeCalendar('<!doctype html><html><body>No events</body></html>')).toBe(false);
    expect(looksLikeCalendar('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBe(true);
    expect(icsToEventItems('', SRC, 'https://plantbasedtreaty.org/events/?ical=1', NOW)).toEqual(
      [],
    );
    expect(
      icsToEventItems('<html></html>', SRC, 'https://plantbasedtreaty.org/events/?ical=1', NOW),
    ).toEqual([]);
  });

  it('applies titleFilter to ICS titles before mapping', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART:20261024T100000Z',
      'SUMMARY:San Diego VegFest',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:2',
      'DTSTART:20261025T100000Z',
      'SUMMARY:Monkey Motorcycle Run',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const items = icsToEventItems(
      ics,
      { ...SRC, titleFilter: 'vegfest|vegan' },
      'https://x.org/?ical=1',
      NOW,
    );
    expect(items.map((i) => i.sourceId)).toEqual(['1']);
  });

  it('applies titleFilter to JSON-LD titles before mapping', () => {
    const html = `<script type="application/ld+json">[
      {"@type":"Event","name":"San Diego VegFest","startDate":"2026-10-26T11:00:00-07:00","url":"https://nsefu.org/calendar-of-events/2026/10/26/san-diego-vegfest"},
      {"@type":"Event","name":"The Nsefu Monkey Motorcycle Run","startDate":"2026-10-03T09:00:00-07:00","url":"https://nsefu.org/calendar-of-events/2026/10/3/run"}
    ]</script>`;
    const items = extractJsonLdEvents(
      html,
      'https://nsefu.org/calendar-of-events',
      { source: 'jsonld:nsefu', hostName: 'Nsefu', titleFilter: 'vegfest|vegan' },
      NOW,
    );
    expect(items.map((i) => i.title)).toEqual(['San Diego VegFest']);
  });

  it('strips query strings from detail links but never follows feed variants', () => {
    const list = `<a href="/events/cube-of-truth-orange-abc123?referrer=eyJ0eXAiOiJKV1Qi">cube</a>
<a href="https://animalrightscalendar.com/events/animal-victory-meetup-def456?referrer=x&utm=y">meetup</a>
<a href="/events/cube-of-truth-orange-abc123?referrer=other">same page, other referrer</a>
<a href="/events/old-thing?format=ical">ical</a>
<a href="/events/old-thing?format=json">json</a>
<a href="/organizations/anonymous-for-the-voiceless">org</a>
<a href="https://arc.cubeoftruth.com/events/ghi789">other origin</a>`;
    const listing =
      'https://animalrightscalendar.com/?coordinates=-118.2437%2C34.0522&city=Los+Angeles';
    expect(collectDetailLinks(list, listing, '^/events/', NOW)).toEqual([
      'https://animalrightscalendar.com/events/cube-of-truth-orange-abc123',
      'https://animalrightscalendar.com/events/animal-victory-meetup-def456',
    ]);
    expect(collectDetailLinks(list, listing, '^/events/', NOW, 1)).toHaveLength(1);
  });

  it('lets a source lower the detail-page cap but never raise it', () => {
    expect(detailPageLimit({})).toBe(50);
    expect(detailPageLimit({ maxPages: 500 })).toBe(50);
    expect(detailPageLimit({ maxPages: 5 })).toBe(5);
    expect(detailPageLimit({ maxPages: 0 })).toBe(1);
  });

  it('reads points from strings and numbers and treats 0,0 as unknown', () => {
    expect(pointOf('33.7607', '-118.1663')).toEqual({ lng: -118.1663, lat: 33.7607 });
    expect(pointOf(0, 0)).toBeUndefined();
    expect(pointOf(null, -118)).toBeUndefined();
    expect(pointOf(91, 0)).toBeUndefined();
    expect(zoneOrDefault('Not/AZone')).toBe('America/Los_Angeles');
    expect(zoneOrDefault('')).toBe('America/Los_Angeles');
    expect(zoneOrDefault('Europe/London')).toBe('Europe/London');
  });

  it('paces requests to one host a second apart and other hosts at once', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
      await paceHost('https://paced.example/one');
      let second = false;
      const pending = paceHost('https://paced.example/two').then(() => {
        second = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(second).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(second).toBe(true);
      let other = false;
      const otherHost = paceHost('https://other.example/one').then(() => {
        other = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await otherHost;
      expect(other).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Mobilize mapping', () => {
  const SRC: EventSource = {
    source: 'mobilize:thehumaneleague',
    kind: 'mobilize',
    hostName: 'The Humane League',
    organizationId: 26695,
    sourceUrl: 'https://www.mobilize.us/thehumaneleague/',
  };
  const unix = (...parts: [number, number, number, number, number]) => Date.UTC(...parts) / 1000;
  const base = {
    timezone: 'America/Los_Angeles',
    visibility: 'PUBLIC',
    approval_status: 'APPROVED',
    contact: { name: 'A Person', email_address: 'person@example.org', phone_number: '5551234567' },
    created_by_volunteer_host: true,
    sponsor: { id: 26695, name: 'The Humane League', slug: 'thehumaneleague' },
    attendees: [{ given_name: 'Someone', email_address: 'someone@example.org' }],
    attendance_count: 12,
  };
  const page = {
    count: 7,
    next: 'https://api.mobilize.us/v1/organizations/26695/events?page=2&per_page=100',
    previous: null,
    data: [
      {
        ...base,
        id: 550184,
        title: 'Demand H Mart (CJ group) end cages: Leafleting!',
        description: '<p>Join us &amp; hand out leaflets.</p>',
        summary: 'Leafleting',
        browser_url: 'https://www.mobilize.us/thehumaneleague/event/550184/',
        event_type: 'VISIBILITY_EVENT',
        is_virtual: false,
        location: {
          venue: 'H Mart Westminster',
          address_lines: ['8911 Westminster Blvd', ''],
          locality: 'Westminster',
          region: 'CA',
          postal_code: '92683',
          country: 'US',
          location: { latitude: 33.7591, longitude: -117.9905 },
          congressional_district: '46',
        },
        timeslots: [
          { id: 1, start_date: unix(2026, 9, 17, 17, 0), end_date: unix(2026, 9, 17, 20, 0) },
          { id: 2, start_date: unix(2020, 0, 1, 18, 0), end_date: unix(2020, 0, 1, 20, 0) },
          { id: 3, start_date: unix(2027, 5, 1, 17, 0), end_date: unix(2027, 5, 1, 20, 0) },
        ],
      },
      {
        ...base,
        id: 551000,
        title: 'Los Angeles and Orange County Team Meeting',
        description: '',
        summary: 'Monthly team meeting on Zoom.',
        browser_url: 'https://www.mobilize.us/thehumaneleague/event/551000/',
        event_type: 'MEETING',
        is_virtual: true,
        location: null,
        timeslots: [
          { id: 7, start_date: unix(2026, 9, 31, 1, 0), end_date: unix(2026, 9, 31, 2, 30) },
        ],
      },
      {
        ...base,
        id: 552000,
        title: 'March for the Hens',
        description: 'Meet at the steps.',
        browser_url: 'https://www.mobilize.us/thehumaneleague/event/552000/',
        event_type: 'RALLY',
        location: { venue: 'City Hall', address_lines: [], locality: 'Los Angeles', region: 'CA' },
        timeslots: [{ id: 9, start_date: unix(2026, 10, 7, 19, 0), end_date: null }],
      },
      {
        ...base,
        id: 553000,
        title: 'Community leafleting at the farmers market',
        browser_url: 'https://www.mobilize.us/thehumaneleague/event/553000/',
        event_type: 'COMMUNITY',
        location: { venue: '', address_lines: [], locality: 'Fullerton', region: 'CA' },
        timeslots: [
          { id: 11, start_date: unix(2026, 10, 14, 17, 0), end_date: unix(2026, 10, 14, 19, 0) },
        ],
      },
      {
        ...base,
        id: 554000,
        title: 'New York leafleting',
        browser_url: 'https://www.mobilize.us/thehumaneleague/event/554000/',
        event_type: 'VISIBILITY_EVENT',
        location: { venue: 'Union Square', locality: 'New York', region: 'NY' },
        timeslots: [{ id: 13, start_date: unix(2026, 9, 20, 17, 0) }],
      },
      {
        ...base,
        id: 555000,
        title: 'Private planning call',
        browser_url: 'https://www.mobilize.us/thehumaneleague/event/555000/',
        event_type: 'MEETING',
        is_virtual: true,
        visibility: 'PRIVATE',
        timeslots: [{ id: 15, start_date: unix(2026, 9, 20, 17, 0) }],
      },
      {
        ...base,
        id: 556000,
        title: 'Not yet approved',
        browser_url: 'https://www.mobilize.us/thehumaneleague/event/556000/',
        event_type: 'MEETING',
        is_virtual: true,
        approval_status: 'PENDING',
        timeslots: [{ id: 17, start_date: unix(2026, 9, 20, 17, 0) }],
      },
    ],
  };

  it('keeps public approved California or virtual events, one item per future timeslot', () => {
    const items = mobilizeToEventItems(page, SRC, NOW);
    expect(items.map((i) => i.sourceId)).toEqual(['550184/1', '551000/7', '552000/9', '553000/11']);
    expect(items[0]).toEqual({
      sourceId: '550184/1',
      title: 'Demand H Mart (CJ group) end cages: Leafleting!',
      type: 'outreach',
      startsAt: '2026-10-17T10:00:00-07:00',
      endsAt: '2026-10-17T13:00:00-07:00',
      venueName: 'H Mart Westminster',
      address: '8911 Westminster Blvd, Westminster, CA 92683',
      location: { lng: -117.9905, lat: 33.7591 },
      hostName: 'The Humane League',
      description: 'Join us & hand out leaflets.',
      sourceUrl: 'https://www.mobilize.us/thehumaneleague/event/550184/',
    });
    expect(items[1]).toMatchObject({
      type: 'meeting',
      startsAt: '2026-10-30T18:00:00-07:00',
      endsAt: '2026-10-30T19:30:00-07:00',
      venueName: 'Online',
      description: 'Monthly team meeting on Zoom.',
    });
    expect(items[1]?.location).toBeUndefined();
    expect(items[2]).toMatchObject({ type: 'protest', startsAt: '2026-11-07T11:00:00-08:00' });
    expect(items[2]?.endsAt).toBeUndefined();
    expect(items[3]).toMatchObject({ type: 'outreach', address: 'Fullerton, CA' });
    expectAccepted(items);
  });

  it('never carries contact, host or attendee data even when the feed sends it', () => {
    const items = mobilizeToEventItems(page, SRC, NOW);
    expectNever(
      items,
      'A Person',
      'person@example.org',
      '5551234567',
      'Someone',
      'someone@example.org',
      'contact',
      'created_by_volunteer_host',
      'sponsor',
      'attendees',
      'attendance_count',
      'congressional_district',
    );
  });

  it('builds the per-organization URL and follows next only on the API host', () => {
    expect(mobilizeEventsUrl(26695)).toBe(
      'https://api.mobilize.us/v1/organizations/26695/events?timeslot_start=gte_now&per_page=100',
    );
    expect(() => mobilizeEventsUrl(0)).toThrow();
    expect(mobilizeNextUrl(page)).toBe(page.next);
    expect(mobilizeNextUrl({ next: null })).toBeNull();
    expect(mobilizeNextUrl({ next: 'https://elsewhere.example/v1/events' })).toBeNull();
    expect(mobilizeToEventItems({ data: [] }, SRC, NOW)).toEqual([]);
    expect(mobilizeToEventItems(null, SRC, NOW)).toEqual([]);
  });
});

describe('Tribe REST mapping', () => {
  const SRC: EventSource = {
    source: 'tribe:plantbasedtreaty',
    kind: 'tribe',
    hostName: 'Plant Based Treaty',
    url: 'https://plantbasedtreaty.org/wp-json/tribe/events/v1/events?per_page=50',
    sourceUrl: 'https://plantbasedtreaty.org/events/',
  };
  const body = {
    events: [
      {
        id: 101,
        global_id: 'plantbasedtreaty.org?id=101',
        title: 'Plant Based Treaty &#8211; LA endorsement rally',
        description: '<p>Rally &amp; speeches on the steps.</p>',
        url: 'https://plantbasedtreaty.org/event/la-rally/',
        start_date: '2026-11-07 11:00:00',
        end_date: '2026-11-07 13:00:00',
        utc_start_date: '2026-11-07 19:00:00',
        utc_end_date: '2026-11-07 21:00:00',
        timezone: 'America/Los_Angeles',
        status: 'publish',
        venue: {
          id: 5,
          venue: 'Los Angeles City Hall',
          address: '200 N Spring St',
          city: 'Los Angeles',
          stateprovince: 'CA',
          zip: '90012',
          geo_lat: '34.0537',
          geo_lng: '-118.2428',
          phone: '555-0100',
        },
        organizer: [{ organizer: 'Jane Organizer', email: 'jane@example.org', phone: '555-0199' }],
      },
      {
        id: 102,
        title: 'Old webinar',
        url: 'https://plantbasedtreaty.org/event/old/',
        start_date: '2020-01-01 10:00:00',
        timezone: 'America/Los_Angeles',
        venue: [],
        organizer: [],
      },
      {
        id: 103,
        title: 'Webinar with wall-clock time only',
        url: 'https://plantbasedtreaty.org/event/webinar/',
        start_date: '2026-12-01 18:00:00',
        end_date: '2026-12-01 19:00:00',
        timezone: 'Europe/London',
        venue: [],
      },
      {
        id: 104,
        title: 'Draft',
        url: 'https://plantbasedtreaty.org/event/draft/',
        start_date: '2026-12-02 18:00:00',
        status: 'draft',
      },
    ],
    total: 4,
    total_pages: 1,
    rest_url: 'https://plantbasedtreaty.org/wp-json/tribe/events/v1/events?per_page=50',
  };

  it('maps events with UTC dates, venues and coordinates, dropping past and unpublished ones', () => {
    const items = tribeToEventItems(body, SRC, NOW);
    expect(items.map((i) => i.sourceId)).toEqual(['plantbasedtreaty.org?id=101', '103']);
    expect(items[0]).toEqual({
      sourceId: 'plantbasedtreaty.org?id=101',
      title: 'Plant Based Treaty - LA endorsement rally',
      type: 'protest',
      startsAt: '2026-11-07T11:00:00-08:00',
      endsAt: '2026-11-07T13:00:00-08:00',
      venueName: 'Los Angeles City Hall',
      address: '200 N Spring St, Los Angeles, CA 90012',
      location: { lng: -118.2428, lat: 34.0537 },
      hostName: 'Plant Based Treaty',
      description: 'Rally & speeches on the steps.',
      sourceUrl: 'https://plantbasedtreaty.org/event/la-rally/',
    });
    expect(items[1]).toMatchObject({
      type: 'meeting',
      startsAt: '2026-12-01T18:00:00+00:00',
      endsAt: '2026-12-01T19:00:00+00:00',
    });
    expect(items[1]?.venueName).toBeUndefined();
    expectAccepted(items);
    expectNever(items, 'Jane Organizer', 'jane@example.org', '555-01', 'organizer');
  });

  it('tolerates an empty answer and pages within the cap', () => {
    expect(tribeToEventItems({ events: [], total: 0, total_pages: 0 }, SRC, NOW)).toEqual([]);
    expect(tribeToEventItems({ events: null }, SRC, NOW)).toEqual([]);
    expect(tribeTotalPages({ total_pages: 0 })).toBe(1);
    expect(tribeTotalPages({ total_pages: 3 })).toBe(3);
    expect(tribeTotalPages({ total_pages: 400 })).toBe(10);
    expect(tribePageUrl(SRC.url as string, 2)).toBe(
      'https://plantbasedtreaty.org/wp-json/tribe/events/v1/events?per_page=50&start_date=now&page=2',
    );
  });
});

describe('static JSON mapping (Sea Shepherd)', () => {
  const SRC: EventSource = {
    source: 'json:seashepherd',
    kind: 'json',
    mapping: 'seashepherd',
    hostName: 'Sea Shepherd Conservation Society',
    url: 'https://seashepherd.org/wp-content/uploads/sscs/events.json',
    sourceUrl: 'https://seashepherd.org/events/',
  };
  const body = {
    ok: true,
    generated: '2026-09-29T20:17:34.000Z',
    counts: { upcoming: 5, past: 1 },
    upcoming: [
      {
        id: 'ev-2026-10-24-tacoma',
        type: 'cleanup',
        title: 'Seattle / Tacoma Cleanup',
        city_label: 'Tacoma, WA',
        date: '2026-10-24',
        start_time: '10:00',
        end_time: '13:00',
        timezone: 'America/Los_Angeles',
        start_iso: '2026-10-24T10:00:00-07:00',
        venue: 'Owen Beach, 5605 N Owen Beach Rd, Tacoma, WA',
        maps_link: 'https://maps.google.com/?q=Owen+Beach',
        lat: 47.3,
        lng: -122.5,
        leader: 'A Leader',
        chapter: 'Seattle',
        chapter_email: 'seattle@example.org',
        sponsor_name: 'Sponsor Co',
        sponsor_url: 'https://sponsor.example',
        bring: 'Gloves and water',
        tickets: '',
      },
      {
        id: 'ev-2026-11-14-longbeach',
        type: 'cleanup',
        title: 'Long Beach Coastal Cleanup',
        city_label: 'Long Beach, CA',
        date: '2026-11-14',
        start_time: '9:00 AM',
        end_time: '12:00 PM',
        timezone: 'America/Los_Angeles',
        start_iso: '2026-11-14T09:00:00-08:00',
        venue: 'Junipero Beach, 2600 E Ocean Blvd',
        maps_link: 'https://maps.google.com/?q=Junipero+Beach',
        lat: '33.7607',
        lng: '-118.1663',
        leader: 'B Leader',
        chapter: 'Los Angeles',
        chapter_email: 'la@example.org',
        sponsor_name: '',
        bring: 'Reusable gloves',
        tickets: 'https://www.eventbrite.com/e/long-beach-cleanup-123',
      },
      {
        id: 'ev-2026-12-05-sd',
        type: 'benefit',
        title: 'San Diego Benefit Show',
        city_label: 'San Diego, CA',
        start_iso: '2026-12-05T19:00:00-08:00',
        end_time: '10:30 PM',
        timezone: 'America/Los_Angeles',
        venue: 'The Casbah, 2501 Kettner Blvd',
        lat: 32.7263,
        lng: -117.1707,
        tickets: 'https://seashepherd.org/events/san-diego-benefit/',
        leader: '',
        chapter_email: '',
      },
      {
        id: 'ev-2026-12-06-oc',
        type: 'meetup',
        title: 'Orange County Chapter Meetup',
        city_label: 'Irvine, California',
        start_iso: '2026-12-06T18:00:00-08:00',
        venue: 'Cafe Common Ground, 1 Main St',
        tickets: '',
      },
      {
        id: 'ev-2020-01-01-old',
        type: 'cleanup',
        title: 'Old cleanup',
        city_label: 'Long Beach, CA',
        start_iso: '2020-01-01T10:00:00-08:00',
      },
    ],
    past: [{ id: 'past-1', title: 'Past thing', city_label: 'Long Beach, CA', leader: 'C Leader' }],
  };

  it('keeps California items, links to the org page unless tickets are on its host', () => {
    const items = seaShepherdToEventItems(body, SRC, NOW);
    expect(items.map((i) => i.sourceId)).toEqual([
      'ev-2026-11-14-longbeach',
      'ev-2026-12-05-sd',
      'ev-2026-12-06-oc',
    ]);
    expect(items[0]).toEqual({
      sourceId: 'ev-2026-11-14-longbeach',
      title: 'Long Beach Coastal Cleanup',
      type: 'other',
      startsAt: '2026-11-14T09:00:00-08:00',
      endsAt: '2026-11-14T12:00:00-08:00',
      venueName: 'Junipero Beach',
      address: '2600 E Ocean Blvd, Long Beach, CA',
      location: { lng: -118.1663, lat: 33.7607 },
      hostName: 'Sea Shepherd Conservation Society',
      description: 'What to bring: Reusable gloves',
      sourceUrl: 'https://seashepherd.org/events/',
    });
    expect(items[1]).toMatchObject({
      endsAt: '2026-12-05T22:30:00-08:00',
      sourceUrl: 'https://seashepherd.org/events/san-diego-benefit/',
      venueName: 'The Casbah',
    });
    expect(items[2]).toMatchObject({ type: 'meeting', address: '1 Main St, Irvine, California' });
    expect(items[2]?.endsAt).toBeUndefined();
    expect(items[2]?.location).toBeUndefined();
    expectAccepted(items);
  });

  it('never carries leaders, chapter emails or sponsors', () => {
    const items = seaShepherdToEventItems(body, { ...SRC, region: 'any' }, NOW);
    expect(items).toHaveLength(4);
    expect(items[0]?.address).toBe('5605 N Owen Beach Rd, Tacoma, WA');
    expectNever(
      items,
      'A Leader',
      'B Leader',
      'C Leader',
      'seattle@example.org',
      'la@example.org',
      'Sponsor Co',
      'sponsor.example',
      'leader',
      'chapter_email',
      'sponsor',
      'eventbrite',
    );
  });

  it('parses clock times and California labels, and names its mappers', () => {
    expect(parseClockTime('17:00')).toBe(17 * 60);
    expect(parseClockTime('5:30 PM')).toBe(17 * 60 + 30);
    expect(parseClockTime('12 am')).toBe(0);
    expect(parseClockTime('noon')).toBeNull();
    expect(isCalifornia('Long Beach, CA')).toBe(true);
    expect(isCalifornia('Irvine, California')).toBe(true);
    expect(isCalifornia('Tacoma, WA')).toBe(false);
    expect(isCalifornia('Casa Blanca')).toBe(false);
    expect(mapperFor('seashepherd')).toBe(seaShepherdToEventItems);
    expect(() => mapperFor('unknown')).toThrow(/unknown json mapping/);
    expect(seaShepherdToEventItems({ ok: true, upcoming: [] }, SRC, NOW)).toEqual([]);
  });
});

describe('DxE mapping', () => {
  const SRC: EventSource = {
    source: 'dxe:losangeles',
    kind: 'dxe',
    hostName: 'Direct Action Everywhere Los Angeles',
    pageId: '153660568381244',
    sourceUrl: 'https://www.directactioneverywhere.com/events',
    defaultType: 'protest',
  };
  const base = {
    PageID: '153660568381244',
    LocationCity: '',
    LocationAddress: '',
    Lat: 0,
    Lng: 0,
    Cover: 'https://scontent.xx.fbcdn.net/v/t39/cover.jpg',
    AttendingCount: 1,
    InterestedCount: 4,
    IsCanceled: false,
    LastUpdate: '2026-09-29T00:00:00Z',
    EventbriteID: '',
    EventbriteURL: '',
    Featured: false,
  };
  const body = {
    events: [
      {
        ...base,
        ID: '1234567890123456',
        Name: "Rose's Law Banner Drops for Animal Rights (6 bridges/6 banners)",
        Description: 'Meet at the bridge. <b>Bring</b> a banner.',
        StartTime: '2026-10-30T23:00:00Z',
        EndTime: '2026-10-31T01:00:00Z',
        LocationName: '2428 3rd Ave, Los Angeles, CA 90018',
      },
      {
        ...base,
        ID: '2',
        Name: 'Cancelled action',
        StartTime: '2026-11-01T18:00:00Z',
        EndTime: '2026-11-01T20:00:00Z',
        LocationName: 'Somewhere',
        IsCanceled: true,
      },
      {
        ...base,
        ID: '3',
        Name: 'Ticketed talk on open rescue',
        Description: '',
        StartTime: '2026-11-05T02:00:00Z',
        EndTime: '2026-11-05T04:00:00Z',
        LocationName: 'DxE House, 1 Main St, Los Angeles, CA',
        EventbriteID: '481516',
        EventbriteURL: 'https://www.eventbrite.com/e/ticketed-talk-999',
      },
      {
        ...base,
        ID: '4',
        Name: 'Facebook-only link',
        StartTime: '2026-11-06T02:00:00Z',
        LocationName: '',
        EventbriteURL: 'https://www.facebook.com/events/4',
      },
      {
        ...base,
        ID: '5',
        Name: 'Long past',
        StartTime: '2020-01-01T02:00:00Z',
        LocationName: '',
      },
    ],
    local_events_found: true,
  };

  it('maps chapter events without coordinates, dropping cancelled and past ones', () => {
    const items = dxeToEventItems(body, SRC, NOW);
    expect(items.map((i) => i.sourceId)).toEqual(['1234567890123456', '3', '4']);
    expect(items[0]).toEqual({
      sourceId: '1234567890123456',
      title: "Rose's Law Banner Drops for Animal Rights (6 bridges/6 banners)",
      type: 'protest',
      startsAt: '2026-10-30T16:00:00-07:00',
      endsAt: '2026-10-30T18:00:00-07:00',
      venueName: undefined,
      address: '2428 3rd Ave, Los Angeles, CA 90018',
      hostName: 'Direct Action Everywhere Los Angeles',
      description: 'Meet at the bridge. Bring a banner.',
      sourceUrl: 'https://www.directactioneverywhere.com/events',
    });
    expect(items[1]).toMatchObject({
      venueName: 'DxE House',
      address: '1 Main St, Los Angeles, CA',
      sourceUrl: 'https://www.eventbrite.com/e/ticketed-talk-999',
    });
    expect(items[2]?.sourceUrl).toBe('https://www.directactioneverywhere.com/events');
    for (const item of items) expect(item.location).toBeUndefined();
    expectAccepted(items);
  });

  it('drops attendee counts, the cover image and the page id by construction', () => {
    const items = dxeToEventItems(body, SRC, NOW);
    expectNever(
      items,
      'AttendingCount',
      'InterestedCount',
      'fbcdn',
      'Cover',
      'PageID',
      '153660568381244',
      'facebook.com',
      'EventbriteID',
      '481516',
      'LastUpdate',
    );
  });

  it('accepts events: null and only ever builds external_events URLs', () => {
    expect(dxeToEventItems({ events: null, local_events_found: false }, SRC, NOW)).toEqual([]);
    expect(dxeToEventItems(null, SRC, NOW)).toEqual([]);
    const url = dxeEventsUrl('153660568381244', new Date('2026-09-30T12:00:00Z'));
    expect(url).toBe(
      'https://adb.dxe.io/external_events/153660568381244?start_time=2026-09-30T11%3A00%3A00.000Z&end_time=2027-03-29T12%3A00%3A00.000Z',
    );
    expect(url).not.toContain('/chapters/');
    expect(() => dxeEventsUrl('34.05,-118.24')).toThrow();
    expect(() => dxeEventsUrl('../chapters/34,-118')).toThrow();
  });
});
