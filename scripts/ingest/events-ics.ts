/**
 * Ingest events from ICS calendar feeds published by allowlisted
 * organizations, then POST them to `/api/ingest/events`.
 *
 *   npm run ingest:events:ics -- --dry-run          # fetch, map, print counts
 *   npm run ingest:events:ics                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:events:ics -- --input other.json # a different source list
 *
 * Source list: scripts/data/event-sources.json, entries shaped
 * `{ source, hostName, ics }`. Entries carrying a `placeholder` note or no
 * `ics` are skipped. Each feed is fetched once, after robots.txt, with a
 * descriptive User-Agent; VEVENTs become items with the UID as `sourceId`
 * (recurring events expand to `UID/occurrence` for the next 90 days), the
 * type guessed from keywords with `other` as the fallback, and times sent
 * with an explicit offset (floating times are read as America/Los_Angeles).
 * Cancelled and long-past events are dropped. Nothing about attendees is
 * ever read: ICS attendee lines are ignored by construction.
 */
import ICAL from 'ical.js';
import type { EventItem } from '../../src/services/ingest.js';
import {
  argValue,
  dataPath,
  isMain,
  postIngest,
  readJson,
  runScript,
  scriptContext,
} from './lib/client.js';
import {
  cleanText,
  DEFAULT_ZONE,
  eventTypeFromText,
  localToIso,
  splitLocation,
  stableId,
  toIsoInZone,
} from './lib/events.js';
import { fetchAllowed } from './lib/http.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = DAY_MS;
const HORIZON_MS = 90 * DAY_MS;
const MAX_OCCURRENCES = 12;

export interface EventSource {
  source: string;
  hostName: string;
  ics?: string;
  url?: string;
  placeholder?: string;
}

function icalTimeToIso(time: ICAL.Time): string | null {
  if (time.zone?.tzid === 'floating' || time.isDate) {
    return localToIso(time.toString().replace(/Z$/, ''), DEFAULT_ZONE);
  }
  return toIsoInZone(time.toJSDate(), DEFAULT_ZONE);
}

function geoOf(vevent: ICAL.Component): { lng: number; lat: number } | undefined {
  const geo = vevent.getFirstPropertyValue('geo');
  if (!Array.isArray(geo) || geo.length !== 2) return undefined;
  const [lat, lng] = geo.map(Number) as [number, number];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lng, lat };
}

function toItem(
  ev: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time | null,
  suffix: string,
  src: EventSource,
  feedUrl: string,
): EventItem | null {
  const startsAt = icalTimeToIso(start);
  if (!startsAt) return null;
  const title = cleanText(ev.summary, 140);
  if (!title) return null;
  const description = cleanText(ev.description, 4000);
  const url = ev.component.getFirstPropertyValue('url');
  const where = splitLocation(cleanText(ev.location, 400));
  const location = geoOf(ev.component);
  return {
    sourceId: stableId(`${ev.uid}${suffix}`),
    title,
    type: eventTypeFromText(`${title} ${description}`),
    startsAt,
    endsAt: end ? (icalTimeToIso(end) ?? undefined) : undefined,
    venueName: where.venueName || undefined,
    address: where.address || undefined,
    location,
    hostName: src.hostName,
    description: description || undefined,
    sourceUrl: typeof url === 'string' && /^https?:\/\//.test(url) ? url.slice(0, 500) : feedUrl,
  };
}

function registerTimezones(root: ICAL.Component): void {
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const tzid = tz.getFirstPropertyValue('tzid');
    if (typeof tzid === 'string' && !ICAL.TimezoneService.has(tzid)) {
      ICAL.TimezoneService.register(tz);
    }
  }
}

function isCancelled(vevent: ICAL.Component): boolean {
  const status = vevent.getFirstPropertyValue('status');
  return typeof status === 'string' && status.toUpperCase() === 'CANCELLED';
}

function singleItem(ev: ICAL.Event, src: EventSource, feedUrl: string, now: Date): EventItem[] {
  const end = ev.endDate ?? ev.startDate;
  if (end.toJSDate().getTime() < now.getTime() - PAST_GRACE_MS) return [];
  const item = toItem(ev, ev.startDate, ev.endDate ?? null, '', src, feedUrl);
  return item ? [item] : [];
}

/** The next occurrences of a recurring event inside the horizon, `UID/occurrence` as the id. */
function occurrenceItems(
  ev: ICAL.Event,
  src: EventSource,
  feedUrl: string,
  now: Date,
): EventItem[] {
  const items: EventItem[] = [];
  const horizonMs = now.getTime() + HORIZON_MS;
  const iterator = ev.iterator();
  for (let next = iterator.next(); next && items.length < MAX_OCCURRENCES; next = iterator.next()) {
    const details = ev.getOccurrenceDetails(next);
    if (details.startDate.toJSDate().getTime() > horizonMs) break;
    if (details.endDate.toJSDate().getTime() < now.getTime() - PAST_GRACE_MS) continue;
    const suffix = `/${next.toString()}`;
    const item = toItem(ev, details.startDate, details.endDate, suffix, src, feedUrl);
    if (item) items.push(item);
  }
  return items;
}

/** Map one feed's text to ingest items. Exported for the tests. */
export function icsToEventItems(
  text: string,
  src: EventSource,
  feedUrl: string,
  now: Date = new Date(),
): EventItem[] {
  const root = new ICAL.Component(ICAL.parse(text));
  registerTimezones(root);
  return root.getAllSubcomponents('vevent').flatMap((vevent) => {
    if (isCancelled(vevent)) return [];
    const ev = new ICAL.Event(vevent);
    return ev.isRecurring()
      ? occurrenceItems(ev, src, feedUrl, now)
      : singleItem(ev, src, feedUrl, now);
  });
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const file = dataPath(argValue(ctx.args, 'input') ?? 'event-sources.json');
  const sources = readJson<EventSource[]>(file).filter((s) => s.ics && !s.placeholder);
  ctx.logger.info({ file, feeds: sources.length }, 'ics sources');

  for (const src of sources) {
    const feedUrl = src.ics as string;
    try {
      const text = await fetchAllowed(feedUrl, { accept: 'text/calendar,*/*' });
      const items = icsToEventItems(text, src, feedUrl);
      ctx.logger.info({ source: src.source, items: items.length }, 'mapped');
      await postIngest(ctx, 'events', src.source, items);
    } catch (err) {
      ctx.logger.error({ source: src.source, err }, 'feed failed');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) runScript(main);
