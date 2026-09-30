/**
 * Ingest events from a static JSON file an organization publishes behind
 * its own events page (`kind: "json"`), then POST them to
 * `/api/ingest/events`.
 *
 *   npm run ingest:events:json -- --dry-run          # fetch, map, print counts
 *   npm run ingest:events:json                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:events:json -- --input other.json # a different source list
 *
 * Every site's file has its own shape, so the allowlist entry names a
 * mapper (`mapping: "seashepherd"`) from the registry below; the next static
 * site is one mapper away. Entries: `{ source, hostName, kind: "json", url,
 * mapping, sourceUrl, region? }`. The file is fetched once, paced, after
 * robots.txt.
 *
 * `seashepherd` reads `upcoming[]` from `wp-content/uploads/sscs/events.json`:
 * id (the `sourceId`), type (cleanup, meetup, benefit), title, city_label,
 * start_iso (offset included), end_time (a clock time on the same day),
 * timezone, venue (first part as venue, the rest as address), lat, lng,
 * bring (the description) and tickets. Only California items are kept
 * (`city_label` or `venue` says ", CA" or "California") unless the entry
 * says `region: "any"`. The type is inferred from the title first, then
 * the file's own type (meetup to meeting, cleanup and benefit to other).
 * `tickets` is the link only when it is on the organization's own host (it
 * is often Eventbrite, which is never followed); otherwise the entry's
 * `sourceUrl` (the public events page), then `maps_link`. `leader`,
 * `chapter_email`, `sponsor_name` and `sponsor_url` are never read.
 */
import type { EventItem } from '../../src/services/ingest.js';
import { isMain, postIngest, runScript, scriptContext } from './lib/client.js';
import {
  cleanText,
  type EventType,
  localToIso,
  matchEventType,
  normalizeDateString,
  pointOf,
  splitLocation,
  stableId,
  zoneOrDefault,
} from './lib/events.js';
import { fetchJsonAllowed, isForbiddenHost } from './lib/http.js';
import { type JsonObject, readArray, readId, readObject, readString } from './lib/json.js';
import { type EventSource, keepsTitle, loadSources } from './lib/sources.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = DAY_MS;

export type JsonMapper = (body: unknown, src: EventSource, now: Date) => EventItem[];

const CALIFORNIA_RE = /,\s*CA\b|\bCalifornia\b/i;

export function isCalifornia(text: string): boolean {
  return CALIFORNIA_RE.test(text);
}

/** `17:00`, `5:00 PM` or `5pm` as minutes since midnight; null when unreadable. */
export function parseClockTime(text: string): number | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function httpsUrl(value: string): string | undefined {
  const trimmed = value.trim();
  return /^https:\/\/\S+$/.test(trimmed) ? trimmed.slice(0, 500) : undefined;
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

const SEA_SHEPHERD_TYPES: Record<string, EventType> = {
  cleanup: 'other',
  meetup: 'meeting',
  benefit: 'other',
};

/** `tickets` on the org's own host, else the public events page, else the map link. */
function seaShepherdLink(ev: JsonObject, src: EventSource): string | undefined {
  const tickets = httpsUrl(readString(ev, 'tickets'));
  if (tickets && hostOf(tickets) === hostOf(src.url)) return tickets;
  if (src.sourceUrl) return src.sourceUrl;
  const maps = httpsUrl(readString(ev, 'maps_link'));
  return maps && !isForbiddenHost(maps) ? maps : undefined;
}

/** `end_time` is a clock time on the start's local day; dropped when it lands before the start. */
function seaShepherdEnd(startsAt: string, ev: JsonObject, zone: string): string | undefined {
  const minutes = parseClockTime(readString(ev, 'end_time'));
  if (minutes === null) return undefined;
  const wall = `${startsAt.slice(0, 10)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
  const endsAt = localToIso(wall, zone);
  return endsAt && new Date(endsAt) >= new Date(startsAt) ? endsAt : undefined;
}

function seaShepherdItem(ev: JsonObject, src: EventSource, now: Date): EventItem | null {
  const id = readId(ev, 'id');
  const title = cleanText(readString(ev, 'title'), 140);
  if (!id || !title || !keepsTitle(src, title)) return null;
  const cityLabel = cleanText(readString(ev, 'city_label'), 120);
  const venueText = cleanText(readString(ev, 'venue'), 400);
  if (src.region !== 'any' && !isCalifornia(`${cityLabel} ${venueText}`)) return null;
  const zone = zoneOrDefault(readString(ev, 'timezone'));
  const startsAt = normalizeDateString(readString(ev, 'start_iso') || readString(ev, 'date'), zone);
  if (!startsAt || new Date(startsAt).getTime() < now.getTime() - PAST_GRACE_MS) return null;
  const sourceUrl = seaShepherdLink(ev, src);
  if (!sourceUrl) return null;
  const where = splitLocation(venueText);
  const address = where.address.toLowerCase().includes(cityLabel.toLowerCase())
    ? where.address
    : [where.address, cityLabel].filter(Boolean).join(', ').slice(0, 240);
  const bring = cleanText(readString(ev, 'bring'), 3980);
  return {
    sourceId: stableId(id),
    title,
    type:
      matchEventType(title) ??
      SEA_SHEPHERD_TYPES[readString(ev, 'type').toLowerCase()] ??
      src.defaultType ??
      'other',
    startsAt,
    endsAt: seaShepherdEnd(startsAt, ev, zone),
    venueName: where.venueName || undefined,
    address: address || undefined,
    location: pointOf(ev.lat, ev.lng),
    hostName: src.hostName,
    description: bring ? `What to bring: ${bring}` : undefined,
    sourceUrl,
  };
}

/** Sea Shepherd's `events.json` to ingest items. Exported for the tests. */
export function seaShepherdToEventItems(
  body: unknown,
  src: EventSource,
  now: Date = new Date(),
): EventItem[] {
  const file = readObject(body);
  if (!file) return [];
  const seen = new Set<string>();
  const items: EventItem[] = [];
  for (const raw of readArray(file.upcoming)) {
    const ev = readObject(raw);
    const item = ev ? seaShepherdItem(ev, src, now) : null;
    if (!item || seen.has(item.sourceId)) continue;
    seen.add(item.sourceId);
    items.push(item);
  }
  return items;
}

/** One named mapper per static site; the allowlist entry's `mapping` picks it. */
export const JSON_MAPPERS: Record<string, JsonMapper> = {
  seashepherd: seaShepherdToEventItems,
};

export function mapperFor(name: string | undefined): JsonMapper {
  const mapper = name ? JSON_MAPPERS[name] : undefined;
  if (!mapper) {
    throw new Error(
      `unknown json mapping "${name ?? ''}"; known: ${Object.keys(JSON_MAPPERS).join(', ')}`,
    );
  }
  return mapper;
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  for (const src of loadSources(ctx, 'json')) {
    try {
      const mapper = mapperFor(src.mapping);
      if (!src.url) throw new Error('url is missing');
      const items = mapper(await fetchJsonAllowed(src.url), src, new Date());
      ctx.logger.info({ source: src.source, mapping: src.mapping, items: items.length }, 'mapped');
      await postIngest(ctx, 'events', src.source, items);
    } catch (err) {
      ctx.logger.error({ source: src.source, err }, 'feed failed');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) runScript(main);
