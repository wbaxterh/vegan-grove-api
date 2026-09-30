import { describe, expect, it } from 'vitest';
import mediaSeed from '../scripts/data/media-seed.json' with { type: 'json' };
import { icsToEventItems } from '../scripts/ingest/events-ics.js';
import { extractJsonLdEvents } from '../scripts/ingest/events-jsonld.js';
import {
  cleanText,
  eventTypeFromText,
  localToIso,
  normalizeDateString,
  splitLocation,
} from '../scripts/ingest/lib/events.js';
import { isForbiddenHost, RobotsRules } from '../scripts/ingest/lib/http.js';
import { type SeedEntry, toItem as seedToItem } from '../scripts/ingest/media-seed.js';
import {
  mergeWatchLinks,
  movieToFields,
  pickTrailer,
  providersToWatchLinks,
  withAttribution,
} from '../scripts/ingest/media-tmdb.js';
import { bindingsToMediaItems } from '../scripts/ingest/media-wikidata.js';
import { eventItemSchema, mediaItemSchema } from '../src/services/ingest.js';

const SRC = { source: 'ics:animalplace', hostName: 'Animal Place' };

describe('event helpers', () => {
  it('guesses the type from keywords with other as the fallback', () => {
    expect(eventTypeFromText('Cube of Truth in Santa Monica')).toBe('outreach');
    expect(eventTypeFromText('Slaughterhouse vigil, bear witness')).toBe('vigil');
    expect(eventTypeFromText('Public Guided Tour, October 24th')).toBe('sanctuary_day');
    expect(eventTypeFromText('Dominion screening and discussion')).toBe('screening');
    expect(eventTypeFromText('Celebration for the Turkeys')).toBe('potluck');
    expect(eventTypeFromText('Come see us at Aftershock')).toBe('other');
  });

  it('cleans double-encoded HTML descriptions', () => {
    expect(cleanText('&lt;p&gt;Join us &amp; say hi [&amp;hellip;]&lt;/p&gt;\\n', 100)).toBe(
      'Join us & say hi [...]',
    );
  });

  it('reads zone-less times as Los Angeles and keeps offsets that are given', () => {
    expect(localToIso('2026-11-21T18:00:00')).toBe('2026-11-21T18:00:00-08:00');
    expect(localToIso('2026-07-04T10:00')).toBe('2026-07-04T10:00:00-07:00');
    expect(localToIso('2026-07-04')).toBe('2026-07-04T00:00:00-07:00');
    expect(normalizeDateString('2026-10-24T10:00:00-07:00')).toBe('2026-10-24T10:00:00-07:00');
    expect(normalizeDateString('2026-10-24T17:00:00Z')).toBe('2026-10-24T10:00:00-07:00');
    expect(normalizeDateString('soon')).toBeNull();
    expect(normalizeDateString(undefined)).toBeNull();
  });

  it('splits a venue from its address', () => {
    expect(splitLocation('Animal Place, 17314 McCourtney Rd, Grass Valley, CA')).toEqual({
      venueName: 'Animal Place',
      address: '17314 McCourtney Rd, Grass Valley, CA',
    });
    expect(splitLocation('1 Pine Ave, Long Beach')).toEqual({
      venueName: '',
      address: '1 Pine Ave, Long Beach',
    });
  });
});

describe('robots.txt', () => {
  const rules = new RobotsRules(`
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
Disallow: /private*
Disallow: /events/?ical=1$
`);

  it('applies the wildcard group with longest match wins', () => {
    expect(rules.allows('/events/')).toBe(true);
    expect(rules.allows('/wp-admin/')).toBe(false);
    expect(rules.allows('/wp-admin/admin-ajax.php')).toBe(true);
    expect(rules.allows('/private-page')).toBe(false);
    expect(rules.allows('/events/?ical=1')).toBe(false);
    expect(rules.allows('/events/?ical=1&x')).toBe(true);
  });

  it('prefers a group naming our token, and allows everything without rules', () => {
    const named = new RobotsRules(
      'User-agent: vegan-grove-ingest\nDisallow: /events/\n\nUser-agent: *\nAllow: /',
    );
    expect(named.allows('/events/')).toBe(false);
    expect(named.allows('/about')).toBe(true);
    expect(new RobotsRules('').allows('/anything')).toBe(true);
  });

  it('refuses the hosts the contract forbids', () => {
    expect(isForbiddenHost('https://www.facebook.com/events/1')).toBe(true);
    expect(isForbiddenHost('https://eventbrite.com/e/1')).toBe(true);
    expect(isForbiddenHost('https://animalplace.org/events/')).toBe(false);
  });
});

describe('ICS mapping', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Animal Place - ECPv6.17.4.1//NONSGML v1.0//EN',
    'BEGIN:VTIMEZONE',
    'TZID:America/Los_Angeles',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'TZNAME:PDT',
    'DTSTART:20260308T100000',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'TZNAME:PST',
    'DTSTART:20261101T090000',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:10001-tour@animalplace.org',
    'DTSTART;TZID=America/Los_Angeles:20261024T100000',
    'DTEND;TZID=America/Los_Angeles:20261024T113000',
    'SUMMARY:Public Guided Tour &#8211; October 24th @ 10 AM',
    'DESCRIPTION:Join us for our next public guided tour!',
    'LOCATION:Animal Place\\, 17314 McCourtney Road\\, Grass Valley\\, CA 95949',
    'GEO:39.19;-121.06',
    'URL:https://animalplace.org/event/public-guided-tour-october-24th-10-am/',
    'ATTENDEE;CN=Someone:mailto:someone@example.org',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:10002-old@animalplace.org',
    'DTSTART:20200101T180000',
    'DTEND:20200101T200000',
    'SUMMARY:Long past event',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:10003-cancelled@animalplace.org',
    'DTSTART:20261201T180000',
    'STATUS:CANCELLED',
    'SUMMARY:Cancelled potluck',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:10004-weekly@animalplace.org',
    'DTSTART:20261005T090000',
    'DTEND:20261005T120000',
    'RRULE:FREQ=WEEKLY;COUNT=20',
    'SUMMARY:Volunteer work day',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('maps VEVENTs to items the API accepts, dropping past and cancelled ones', () => {
    const now = new Date('2026-10-01T00:00:00-07:00');
    const items = icsToEventItems(ics, SRC, 'https://animalplace.org/events/?ical=1', now);
    const tour = items.find((i) => i.sourceId === '10001-tour@animalplace.org');
    expect(tour).toMatchObject({
      title: 'Public Guided Tour - October 24th @ 10 AM',
      type: 'sanctuary_day',
      startsAt: '2026-10-24T10:00:00-07:00',
      endsAt: '2026-10-24T11:30:00-07:00',
      venueName: 'Animal Place',
      address: '17314 McCourtney Road, Grass Valley, CA 95949',
      location: { lng: -121.06, lat: 39.19 },
      hostName: 'Animal Place',
      sourceUrl: 'https://animalplace.org/event/public-guided-tour-october-24th-10-am/',
    });
    expect(JSON.stringify(tour)).not.toContain('someone');
    expect(items.some((i) => i.sourceId.startsWith('10002'))).toBe(false);
    expect(items.some((i) => i.sourceId.startsWith('10003'))).toBe(false);

    const weekly = items.filter((i) => i.sourceId.startsWith('10004-weekly@animalplace.org/'));
    expect(weekly.length).toBeGreaterThanOrEqual(12);
    expect(weekly[0]?.startsAt).toBe('2026-10-05T09:00:00-07:00');
    expect(weekly[0]?.sourceId).toBe('10004-weekly@animalplace.org/2026-10-05T09:00:00');

    for (const item of items)
      expect(eventItemSchema.safeParse(item).success, item.sourceId).toBe(true);
  });
});

describe('JSON-LD mapping', () => {
  const html = `<!doctype html><html><head>
<script type="application/ld+json">[{"@context":"http://schema.org","@type":"Event","name":"Public Guided Tour &#8211; October 24th @ 10 AM","description":"&lt;p&gt;Join us!&lt;/p&gt;","url":"https://animalplace.org/event/public-guided-tour/","eventStatus":"https://schema.org/EventScheduled","startDate":"2026-10-24T10:00:00-07:00","endDate":"2026-10-24T11:30:00-07:00","location":{"@type":"Place","name":"Animal Place","address":{"@type":"PostalAddress","streetAddress":"17314 McCourtney Rd","addressLocality":"Grass Valley","addressRegion":"CA","postalCode":"95949"},"geo":{"@type":"GeoCoordinates","latitude":"39.19","longitude":"-121.06"}},"performer":"Organization","organizer":{"@type":"Person","name":"A Person","email":"a@example.org"}},{"@type":"Event","name":"Cancelled thing","startDate":"2026-11-01T10:00:00-07:00","eventStatus":"https://schema.org/EventCancelled"}]</script>
<script type="application/ld+json">{ not json }</script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"Events"},{"@type":"SocialEvent","@id":"https://example.org/events/potluck#event","name":"Autumn potluck","startDate":"2026-11-15T17:00:00","location":"Community Hall, 1 Main St, Ojai, CA"}]}</script>
</head><body></body></html>`;

  it('extracts Event nodes from arrays and @graph and maps them', () => {
    const items = extractJsonLdEvents(html, 'https://animalplace.org/events/', {
      source: 'jsonld:animalplace',
      hostName: 'Animal Place',
    });
    expect(items.map((i) => i.sourceId)).toEqual([
      'https://animalplace.org/event/public-guided-tour/',
      'https://example.org/events/potluck#event',
    ]);
    expect(items[0]).toMatchObject({
      title: 'Public Guided Tour - October 24th @ 10 AM',
      type: 'sanctuary_day',
      startsAt: '2026-10-24T10:00:00-07:00',
      endsAt: '2026-10-24T11:30:00-07:00',
      venueName: 'Animal Place',
      address: '17314 McCourtney Rd, Grass Valley, CA 95949',
      location: { lng: -121.06, lat: 39.19 },
      description: 'Join us!',
      sourceUrl: 'https://animalplace.org/event/public-guided-tour/',
    });
    expect(JSON.stringify(items)).not.toContain('A Person');
    expect(JSON.stringify(items)).not.toContain('a@example');
    expect(items[1]).toMatchObject({
      type: 'potluck',
      startsAt: '2026-11-15T17:00:00-08:00',
      venueName: 'Community Hall',
      address: '1 Main St, Ojai, CA',
      sourceUrl: 'https://animalplace.org/events/',
    });
    for (const item of items) expect(eventItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('media mapping', () => {
  it('collapses Wikidata bindings into one item per film', () => {
    const v = (value: string) => ({ value });
    const items = bindingsToMediaItems([
      {
        item: v('http://www.wikidata.org/entity/Q1277684'),
        itemLabel: v('Earthlings'),
        subject: v('http://www.wikidata.org/entity/Q40053'),
        cls: v('http://www.wikidata.org/entity/Q11424'),
        date: v('2005-09-24T00:00:00Z'),
        imdb: v('tt0358456'),
        doc: v('true'),
      },
      {
        item: v('http://www.wikidata.org/entity/Q1277684'),
        itemLabel: v('Earthlings'),
        subject: v('http://www.wikidata.org/entity/Q203986'),
        cls: v('http://www.wikidata.org/entity/Q11424'),
        date: v('2006-01-01T00:00:00Z'),
        tmdb: v('39440'),
      },
      { item: v('http://www.wikidata.org/entity/Q1'), itemLabel: v('Q1') },
    ]);
    expect(items).toEqual([
      {
        sourceId: 'Q1277684',
        title: 'Earthlings',
        kind: 'documentary',
        year: 2005,
        tags: ['wikidata', 'animal-cruelty', 'speciesism'],
        externalIds: { wikidata: 'Q1277684', imdb: 'tt0358456', tmdb: '39440' },
        sourceUrl: 'https://www.wikidata.org/wiki/Q1277684',
      },
    ]);
    expect(mediaItemSchema.safeParse(items[0]).success).toBe(true);
  });

  it('maps every curated seed entry to an item the API schema accepts', () => {
    // The seed file keeps TMDB ids as numbers; the API wants the digit string.
    const item = seedToItem({
      title: 'Earthlings',
      year: 2005,
      wikidata: 'Q1277684',
      tmdb: 30238,
      tags: ['ethics'],
      watchLinks: [{ provider: 'Official', url: 'https://example.test/e', access: 'free' }],
      actions: [{ label: 'Give', url: 'https://example.test/give', type: 'donate' }],
      featured: true,
    });
    expect(item.externalIds).toEqual({ wikidata: 'Q1277684', tmdb: '30238' });
    expect(item.kind).toBe('documentary');
    expect(item.tags).toEqual(['curated', 'ethics']);
    expect(item).not.toHaveProperty('featured');
    expect(mediaItemSchema.safeParse(item).success).toBe(true);
    // The curated free link survives enrichment and leads the providers.
    expect(
      mergeWatchLinks(
        [{ provider: 'Official', url: 'https://example.test/e', access: 'free' }],
        [
          { provider: 'Netflix', url: 'https://jw.example/e' },
          { provider: 'Official', url: 'https://example.test/e' },
        ],
      ),
    ).toEqual([
      { provider: 'Official', url: 'https://example.test/e', access: 'free' },
      { provider: 'Netflix', url: 'https://jw.example/e' },
    ]);
    const okja = seedToItem({ title: 'Okja', year: 2017 });
    expect(okja).toMatchObject({ sourceId: 'okja', kind: 'film', tags: ['curated'] });
    expect(okja).not.toHaveProperty('externalIds');

    const failures = (mediaSeed as SeedEntry[])
      .map((entry) => ({ entry, result: mediaItemSchema.safeParse(seedToItem(entry)) }))
      .filter(({ result }) => !result.success)
      .map(({ entry }) => entry.title);
    expect(failures).toEqual([]);
  });

  it('maps a TMDB movie with appended credits, videos and certifications to item fields', () => {
    const movie = {
      overview: '  A film about the cause.  ',
      tagline: 'See it.',
      release_date: '2018-03-29',
      runtime: 120.4,
      genres: [{ name: 'Documentary' }, { name: '' }],
      vote_average: 8.66,
      vote_count: 412,
      original_language: 'en',
      videos: {
        results: [
          { site: 'YouTube', type: 'Teaser', key: 'teaser_01', official: true },
          { site: 'Vimeo', type: 'Trailer', key: 'vimeo1234', official: true },
          { site: 'YouTube', type: 'Trailer', key: 'fan_trailer1', official: false },
          { site: 'YouTube', type: 'Trailer', key: 'official_tr1', official: true },
        ],
      },
      credits: {
        crew: [
          { job: 'Producer', name: 'P' },
          { job: 'Director', name: 'Chris Delforce' },
          { job: 'Director', name: 'Chris Delforce' },
        ],
        cast: [
          { name: 'Joaquin Phoenix', order: 1 },
          { name: 'Rooney Mara', order: 0 },
          { name: 'Sia', order: 2 },
        ],
      },
      release_dates: {
        results: [
          { iso_3166_1: 'AU', release_dates: [{ certification: 'MA15+' }] },
          { iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'NR' }] },
        ],
      },
    };
    const fields = movieToFields(movie);
    expect(fields).toEqual({
      year: 2018,
      releaseDate: '2018-03-29',
      synopsis: 'A film about the cause.',
      tagline: 'See it.',
      runtimeMinutes: 120,
      directors: ['Chris Delforce'],
      featuring: ['Rooney Mara', 'Joaquin Phoenix', 'Sia'],
      genres: ['Documentary'],
      rating: 8.7,
      ratingCount: 412,
      contentRating: 'NR',
      originalLanguage: 'en',
      trailerYoutubeId: 'official_tr1',
    });
    expect(
      mediaItemSchema.safeParse({ sourceId: 'Q1', title: 'T', kind: 'film', ...fields }).success,
    ).toBe(true);
    // No votes means no rating, and a teaser is the fallback when there is no trailer.
    expect(movieToFields({ vote_average: 7, vote_count: 0 })).toEqual({});
    expect(
      pickTrailer({ videos: { results: [{ site: 'YouTube', type: 'Teaser', key: 'teaser_01' }] } }),
    ).toBe('teaser_01');
  });

  it('turns TMDB providers into watch links and adds the JustWatch attribution', () => {
    const links = providersToWatchLinks({
      results: {
        US: {
          link: 'https://www.themoviedb.org/movie/39440/watch?locale=US',
          flatrate: [{ provider_name: 'Tubi' }],
          rent: [{ provider_name: 'Apple TV' }, { provider_name: 'Tubi' }],
        },
      },
    });
    expect(links).toEqual([
      { provider: 'Tubi', url: 'https://www.themoviedb.org/movie/39440/watch?locale=US' },
      { provider: 'Apple TV', url: 'https://www.themoviedb.org/movie/39440/watch?locale=US' },
    ]);
    expect(providersToWatchLinks({ results: {} })).toEqual([]);
    expect(withAttribution(['wikidata'])).toEqual([
      'wikidata',
      'tmdb',
      'Watch providers data by JustWatch',
    ]);
  });
});
