/**
 * Ingest events from the Mobilize public API for allowlisted organizations
 * (`kind: "mobilize"`), then POST them to `/api/ingest/events`.
 *
 *   npm run ingest:events:mobilize -- --dry-run          # fetch, map, print counts
 *   npm run ingest:events:mobilize                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:events:mobilize -- --input other.json # a different source list
 *
 * Source list: scripts/data/event-sources.json, entries shaped
 * `{ source, hostName, kind: "mobilize", organizationId, sourceUrl }`. Each
 * organization is one paced request to
 * `https://api.mobilize.us/v1/organizations/<id>/events?timeslot_start=gte_now&per_page=100`
 * plus its `next` pages (the host answers 403 for robots.txt, which counts
 * as absent; no key is needed). Only events that are `PUBLIC` and
 * `APPROVED` and either in California (`location.region`) or virtual are
 * kept. Every timeslot that has not ended and starts inside the next 90
 * days becomes one item with `<event id>/<timeslot id>` as `sourceId`;
 * times come from the unix timestamps rendered in the event's own timezone.
 * The type is Mobilize's own event_type where it maps cleanly (RALLY to
 * protest, VISIBILITY_EVENT to outreach, MEETING, MEET_GREET and WORKSHOP
 * to meeting), else keywords in the title, else the entry's `defaultType`.
 *
 * The fields read are id, title, description (or summary), browser_url,
 * timezone, timeslots, location, is_virtual, event_type, visibility and
 * approval_status. `contact`, `created_by_volunteer_host`, `sponsor` and
 * anything about attendees are never read: an item is built from named
 * fields through lib/json.ts, never spread from the response.
 */
import type { EventItem } from '../../src/services/ingest.js';
import { isMain, postIngest, runScript, scriptContext } from './lib/client.js';
import {
  cleanText,
  type EventType,
  matchEventType,
  pointOf,
  stableId,
  toIsoInZone,
  zoneOrDefault,
} from './lib/events.js';
import { fetchJsonAllowed } from './lib/http.js';
import {
  type JsonObject,
  readArray,
  readId,
  readNumber,
  readObject,
  readString,
} from './lib/json.js';
import { type EventSource, keepsTitle, loadSources } from './lib/sources.js';

const API_ORIGIN = 'https://api.mobilize.us';
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = DAY_MS;
const HORIZON_MS = 90 * DAY_MS;
const MAX_PAGES = 20;

/** Mobilize's own classification where it maps cleanly; the rest is inferred from the title. */
const EVENT_TYPE_MAP: Record<string, EventType> = {
  RALLY: 'protest',
  VISIBILITY_EVENT: 'outreach',
  MEETING: 'meeting',
  MEET_GREET: 'meeting',
  WORKSHOP: 'meeting',
};

export function mobilizeEventsUrl(organizationId: number): string {
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error('organizationId must be a positive integer');
  }
  return `${API_ORIGIN}/v1/organizations/${organizationId}/events?timeslot_start=gte_now&per_page=100`;
}

/** The `next` page when the API offers one on its own host; null otherwise. */
export function mobilizeNextUrl(page: unknown): string | null {
  const body = readObject(page);
  const next = body ? readString(body, 'next') : '';
  return next.startsWith(`${API_ORIGIN}/`) ? next : null;
}

function isEligible(ev: JsonObject): boolean {
  if (readString(ev, 'visibility').toUpperCase() !== 'PUBLIC') return false;
  if (readString(ev, 'approval_status').toUpperCase() !== 'APPROVED') return false;
  const location = readObject(ev.location);
  const region = location ? readString(location, 'region').trim().toUpperCase() : '';
  return region === 'CA' || ev.is_virtual === true;
}

function placeOf(ev: JsonObject): Pick<EventItem, 'venueName' | 'address' | 'location'> {
  const loc = readObject(ev.location);
  if (!loc) return ev.is_virtual === true ? { venueName: 'Online' } : {};
  const venueName = cleanText(readString(loc, 'venue'), 120);
  const lines = readArray(loc.address_lines).map((l) =>
    typeof l === 'string' ? cleanText(l, 120) : '',
  );
  const region = [readString(loc, 'region'), readString(loc, 'postal_code')]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
  const cityLine = [readString(loc, 'locality'), region]
    .map((p) => cleanText(p, 120))
    .filter(Boolean)
    .join(', ');
  const address = [...lines, cityLine].filter(Boolean).join(', ').slice(0, 240);
  const point = readObject(loc.location);
  return {
    venueName: venueName || (ev.is_virtual === true && !address ? 'Online' : undefined),
    address: address || undefined,
    location: point ? pointOf(point.latitude, point.longitude) : undefined,
  };
}

function eventType(ev: JsonObject, text: string, src: EventSource): EventType {
  const own = EVENT_TYPE_MAP[readString(ev, 'event_type').toUpperCase()];
  return own ?? matchEventType(text) ?? src.defaultType ?? 'other';
}

interface EventHeader {
  eventId: string;
  zone: string;
  /** Everything the timeslots of one event share. */
  shared: Omit<EventItem, 'sourceId' | 'startsAt' | 'endsAt'>;
}

/** The fields every item of an event shares, or null when the event cannot become one. */
function eventHeader(ev: JsonObject, src: EventSource): EventHeader | null {
  const eventId = readId(ev, 'id');
  const title = cleanText(readString(ev, 'title'), 140);
  if (!eventId || !title || !keepsTitle(src, title)) return null;
  const browserUrl = readString(ev, 'browser_url').trim();
  const sourceUrl = /^https:\/\//.test(browserUrl) ? browserUrl.slice(0, 500) : src.sourceUrl;
  if (!sourceUrl) return null;
  const description = cleanText(readString(ev, 'description') || readString(ev, 'summary'), 4000);
  return {
    eventId,
    zone: zoneOrDefault(readString(ev, 'timezone')),
    shared: {
      title,
      type: eventType(ev, `${title} ${description}`, src),
      ...placeOf(ev),
      hostName: src.hostName,
      description: description || undefined,
      sourceUrl,
    },
  };
}

/** A timeslot's window in ms when it has not ended and starts inside the horizon; null otherwise. */
function slotWindow(slot: JsonObject, now: Date): { startMs: number; endMs: number | null } | null {
  const start = readNumber(slot, 'start_date');
  if (start === null) return null;
  const end = readNumber(slot, 'end_date');
  const startMs = start * 1000;
  const endMs = end === null ? null : end * 1000;
  const lastMs = endMs ?? startMs;
  if (lastMs < startMs) return null;
  if (lastMs < now.getTime() - PAST_GRACE_MS || startMs > now.getTime() + HORIZON_MS) return null;
  return { startMs, endMs };
}

/** One item per timeslot that has not ended and starts inside the horizon. */
function slotItems(ev: JsonObject, src: EventSource, now: Date): EventItem[] {
  const header = eventHeader(ev, src);
  if (!header) return [];
  const items: EventItem[] = [];
  for (const raw of readArray(ev.timeslots)) {
    const slot = readObject(raw);
    const slotId = slot ? readId(slot, 'id') : '';
    const window = slot && slotId ? slotWindow(slot, now) : null;
    if (!window) continue;
    items.push({
      sourceId: stableId(`${header.eventId}/${slotId}`),
      ...header.shared,
      startsAt: toIsoInZone(new Date(window.startMs), header.zone),
      endsAt: window.endMs === null ? undefined : toIsoInZone(new Date(window.endMs), header.zone),
    });
  }
  return items;
}

/** Map one API page to ingest items. Exported for the tests. */
export function mobilizeToEventItems(
  page: unknown,
  src: EventSource,
  now: Date = new Date(),
): EventItem[] {
  const body = readObject(page);
  if (!body) return [];
  return readArray(body.data).flatMap((raw) => {
    const ev = readObject(raw);
    return ev && isEligible(ev) ? slotItems(ev, src, now) : [];
  });
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  for (const src of loadSources(ctx, 'mobilize')) {
    try {
      if (src.organizationId === undefined) throw new Error('organizationId is missing');
      const items: EventItem[] = [];
      const seen = new Set<string>();
      let url: string | null = mobilizeEventsUrl(src.organizationId);
      for (let page = 0; url && page < MAX_PAGES; page += 1) {
        const body = await fetchJsonAllowed(url);
        for (const item of mobilizeToEventItems(body, src)) {
          if (seen.has(item.sourceId)) continue;
          seen.add(item.sourceId);
          items.push(item);
        }
        url = mobilizeNextUrl(body);
      }
      ctx.logger.info({ source: src.source, items: items.length }, 'mapped');
      await postIngest(ctx, 'events', src.source, items);
    } catch (err) {
      ctx.logger.error({ source: src.source, err }, 'feed failed');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) runScript(main);
