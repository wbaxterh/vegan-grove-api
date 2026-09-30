/**
 * Ingest events from The Events Calendar's REST API (`kind: "tribe"`) on
 * allowlisted WordPress sites, then POST them to `/api/ingest/events`.
 *
 *   npm run ingest:events:tribe -- --dry-run          # fetch, map, print counts
 *   npm run ingest:events:tribe                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:events:tribe -- --input other.json # a different source list
 *
 * Source list: scripts/data/event-sources.json, entries shaped
 * `{ source, hostName, kind: "tribe", url, sourceUrl? }` where `url` is the
 * site's `wp-json/tribe/events/v1/events` endpoint. Pages are read as
 * `?per_page=50&start_date=now&page=n` (paced, robots.txt respected) up to
 * `total_pages`; `{ events: [] }` is a valid empty answer. The fields read
 * are title, description (HTML stripped), url, status, utc_start_date and
 * utc_end_date (else start_date and end_date as wall clock in the event's
 * timezone), venue (venue, address, city, stateprovince, zip, geo_lat,
 * geo_lng) and global_id or id for the `sourceId`. `organizer` is never
 * read. The type comes from keywords, then `defaultType`, then `other`.
 */
import type { EventItem } from '../../src/services/ingest.js';
import { isMain, postIngest, runScript, scriptContext } from './lib/client.js';
import {
  cleanText,
  inferEventType,
  localToIso,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = DAY_MS;
const PER_PAGE = 50;
const MAX_PAGES = 10;

export function tribePageUrl(endpoint: string, page: number): string {
  const url = new URL(endpoint);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('start_date', 'now');
  url.searchParams.set('page', String(page));
  return url.toString();
}

/** `total_pages` from a page body, at least 1 and never past the cap. */
export function tribeTotalPages(body: unknown): number {
  const page = readObject(body);
  const total = page ? readNumber(page, 'total_pages') : null;
  return total === null ? 1 : Math.max(1, Math.min(MAX_PAGES, Math.floor(total)));
}

/** `2026-11-07 19:00:00` in UTC when given, else the wall clock in `zone`, as ISO with offset. */
function tribeTime(utc: string, local: string, zone: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(utc.trim());
  if (match) {
    const instant = new Date(`${match[1]}T${match[2]}Z`);
    if (!Number.isNaN(instant.getTime())) return toIsoInZone(instant, zone);
  }
  return local ? localToIso(local, zone) : null;
}

function venueOf(ev: JsonObject): Pick<EventItem, 'venueName' | 'address' | 'location'> {
  const venue = readObject(ev.venue); // Tribe sends [] when the event has none.
  if (!venue) return {};
  const venueName = cleanText(readString(venue, 'venue'), 120);
  const region = [readString(venue, 'stateprovince'), readString(venue, 'zip')]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
  const address = [readString(venue, 'address'), readString(venue, 'city'), region]
    .map((p) => cleanText(p, 120))
    .filter(Boolean)
    .join(', ')
    .slice(0, 240);
  return {
    venueName: venueName || undefined,
    address: address || undefined,
    location: pointOf(venue.geo_lat, venue.geo_lng),
  };
}

function toItem(ev: JsonObject, src: EventSource, now: Date): EventItem | null {
  const status = readString(ev, 'status');
  if (status && status !== 'publish') return null;
  const title = cleanText(readString(ev, 'title'), 140);
  if (!title || !keepsTitle(src, title)) return null;
  const zone = zoneOrDefault(readString(ev, 'timezone'));
  const startsAt = tribeTime(readString(ev, 'utc_start_date'), readString(ev, 'start_date'), zone);
  if (!startsAt) return null;
  const endsAt = tribeTime(readString(ev, 'utc_end_date'), readString(ev, 'end_date'), zone);
  if (endsAt && new Date(endsAt) < new Date(startsAt)) return null;
  if (new Date(endsAt ?? startsAt).getTime() < now.getTime() - PAST_GRACE_MS) return null;
  const url = readString(ev, 'url').trim();
  const sourceUrl = /^https?:\/\//.test(url) ? url.slice(0, 500) : src.sourceUrl;
  const id = readString(ev, 'global_id').trim() || readId(ev, 'id') || url;
  if (!sourceUrl || !id) return null;
  const description = cleanText(readString(ev, 'description'), 4000);
  return {
    sourceId: stableId(id),
    title,
    type: inferEventType(`${title} ${description}`, src),
    startsAt,
    endsAt: endsAt ?? undefined,
    ...venueOf(ev),
    hostName: src.hostName,
    description: description || undefined,
    sourceUrl,
  };
}

/** Map one REST page to ingest items. Exported for the tests. */
export function tribeToEventItems(
  body: unknown,
  src: EventSource,
  now: Date = new Date(),
): EventItem[] {
  const page = readObject(body);
  if (!page) return [];
  const seen = new Set<string>();
  const items: EventItem[] = [];
  for (const raw of readArray(page.events)) {
    const ev = readObject(raw);
    const item = ev ? toItem(ev, src, now) : null;
    if (!item || seen.has(item.sourceId)) continue;
    seen.add(item.sourceId);
    items.push(item);
  }
  return items;
}

/** Every page of one endpoint, de-duplicated by sourceId. */
async function fetchTribeItems(
  endpoint: string,
  src: EventSource,
): Promise<{ items: EventItem[]; pages: number }> {
  const items: EventItem[] = [];
  const seen = new Set<string>();
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    const body = await fetchJsonAllowed(tribePageUrl(endpoint, page));
    if (page === 1) pages = tribeTotalPages(body);
    for (const item of tribeToEventItems(body, src)) {
      if (seen.has(item.sourceId)) continue;
      seen.add(item.sourceId);
      items.push(item);
    }
  }
  return { items, pages };
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  for (const src of loadSources(ctx, 'tribe')) {
    const endpoint = src.url;
    if (!endpoint) {
      ctx.logger.warn({ source: src.source }, 'no url; skipped');
      continue;
    }
    try {
      const { items, pages } = await fetchTribeItems(endpoint, src);
      ctx.logger.info({ source: src.source, items: items.length, pages }, 'mapped');
      await postIngest(ctx, 'events', src.source, items);
    } catch (err) {
      ctx.logger.error({ source: src.source, err }, 'feed failed');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) runScript(main);
