/**
 * Ingest events from Direct Action Everywhere's activist database for
 * allowlisted chapters (`kind: "dxe"`), then POST them to
 * `/api/ingest/events`.
 *
 *   npm run ingest:events:dxe -- --dry-run          # fetch, map, print counts
 *   npm run ingest:events:dxe                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:events:dxe -- --input other.json # a different source list
 *
 * Source list: scripts/data/event-sources.json, entries shaped
 * `{ source, hostName, kind: "dxe", pageId, sourceUrl, enabled }`, one per
 * chapter. The only endpoint called is
 * `https://adb.dxe.io/external_events/<pageId>?start_time=<now-1h>&end_time=<now+180d>`,
 * the window the org's own events page uses (the host has no robots.txt;
 * requests are still paced). `/chapters/<lat,lng>` returns internal fields
 * and is never called: the URL builder knows only external_events and
 * refuses anything but a digits-only page id. `{ events: null }` is a valid
 * empty answer and the endpoint is undocumented, so a failure is logged and
 * the run continues.
 *
 * The fields read are ID (the `sourceId`), Name, Description, StartTime and
 * EndTime (UTC), LocationName (first line as venue, the rest as address),
 * IsCanceled (dropped) and EventbriteURL (the link when present, else the
 * chapter's public events page from the entry; a Facebook URL is never the
 * link). No coordinates are sent, so the API stores the event without a map
 * pin for an admin to place. AttendingCount and InterestedCount (attendee
 * data), Cover (a hot-linked image), PageID, EventbriteID, Lat and Lng are
 * never read.
 *
 * The data is Facebook-derived: DxE syncs its chapters' Facebook events into
 * this database and serves them from its own domain. The entries ship
 * `enabled: false` with a `decision` note until the owner rules on that, and
 * the source stays out of TRUSTED_SOURCES so its items land as pending.
 */
import type { EventItem } from '../../src/services/ingest.js';
import { isMain, postIngest, runScript, scriptContext } from './lib/client.js';
import {
  cleanText,
  inferEventType,
  normalizeDateString,
  splitLocation,
  stableId,
} from './lib/events.js';
import { fetchJsonAllowed } from './lib/http.js';
import { type JsonObject, readArray, readId, readObject, readString } from './lib/json.js';
import { type EventSource, keepsTitle, loadSources } from './lib/sources.js';

const ADB_ORIGIN = 'https://adb.dxe.io';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PAST_GRACE_MS = DAY_MS;
const LOOKBACK_MS = HOUR_MS;
const WINDOW_MS = 180 * DAY_MS;

/** The one endpoint this script may call; a page id that is not all digits is refused. */
export function dxeEventsUrl(pageId: number | string, now: Date = new Date()): string {
  const id = String(pageId);
  if (!/^\d{5,20}$/.test(id)) throw new Error('pageId must be a digits-only chapter page id');
  const url = new URL(`${ADB_ORIGIN}/external_events/${id}`);
  url.searchParams.set('start_time', new Date(now.getTime() - LOOKBACK_MS).toISOString());
  url.searchParams.set('end_time', new Date(now.getTime() + WINDOW_MS).toISOString());
  return url.toString();
}

/** `EventbriteURL` when it really is one; the chapter's public events page otherwise. */
function linkOf(ev: JsonObject, src: EventSource): string | undefined {
  const eventbrite = readString(ev, 'EventbriteURL').trim();
  try {
    const url = new URL(eventbrite);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === 'https:' &&
      (host === 'eventbrite.com' || host.endsWith('.eventbrite.com'))
    ) {
      return eventbrite.slice(0, 500);
    }
  } catch {
    // Empty or not a URL: fall through to the chapter page.
  }
  return src.sourceUrl;
}

function toItem(ev: JsonObject, src: EventSource, now: Date): EventItem | null {
  if (ev.IsCanceled === true) return null;
  const id = readId(ev, 'ID');
  const title = cleanText(readString(ev, 'Name'), 140);
  if (!id || !title || !keepsTitle(src, title)) return null;
  const startsAt = normalizeDateString(readString(ev, 'StartTime'));
  if (!startsAt) return null;
  const endsAt = normalizeDateString(readString(ev, 'EndTime')) ?? undefined;
  if (endsAt && new Date(endsAt) < new Date(startsAt)) return null;
  if (new Date(endsAt ?? startsAt).getTime() < now.getTime() - PAST_GRACE_MS) return null;
  const sourceUrl = linkOf(ev, src);
  if (!sourceUrl) return null;
  const description = cleanText(readString(ev, 'Description'), 4000);
  const where = splitLocation(cleanText(readString(ev, 'LocationName'), 400));
  return {
    sourceId: stableId(id),
    title,
    type: inferEventType(`${title} ${description}`, src),
    startsAt,
    endsAt,
    venueName: where.venueName || undefined,
    address: where.address || undefined,
    hostName: src.hostName,
    description: description || undefined,
    sourceUrl,
  };
}

/** Map one chapter's response to ingest items; `events: null` is zero items. Exported for the tests. */
export function dxeToEventItems(
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

async function main(): Promise<void> {
  const ctx = scriptContext();
  for (const src of loadSources(ctx, 'dxe')) {
    try {
      if (src.pageId === undefined) throw new Error('pageId is missing');
      const body = await fetchJsonAllowed(dxeEventsUrl(src.pageId));
      const items = dxeToEventItems(body, src);
      ctx.logger.info({ source: src.source, items: items.length }, 'mapped');
      await postIngest(ctx, 'events', src.source, items);
    } catch (err) {
      ctx.logger.error({ source: src.source, err }, 'feed failed');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) runScript(main);
