/**
 * Ingest events from schema.org `Event` JSON-LD on allowlisted pages, then
 * POST them to `/api/ingest/events`.
 *
 *   npm run ingest:events:jsonld -- --dry-run          # fetch, map, print counts
 *   npm run ingest:events:jsonld                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:events:jsonld -- --input other.json # a different source list
 *
 * Source list: scripts/data/event-sources.json, entries shaped
 * `{ source, hostName, url, detailLinkPattern? }`; entries with a
 * `placeholder` note or no `url` are skipped. The list page is fetched once
 * after robots.txt with a descriptive User-Agent. Every
 * `<script type="application/ld+json">` is parsed; plain objects, arrays and
 * `@graph` are walked and anything typed `Event` (or a subtype such as
 * `SocialEvent`) becomes an item.
 *
 * Squarespace and Wix sites put the Event JSON-LD on each event's detail
 * page, not the list. For those, `detailLinkPattern` is a regex matched
 * against same-origin links on the list page; the matching pages (at most
 * 50, one request per second, robots.txt respected on each, links whose path
 * carries a date more than a month old skipped) are fetched and mined the
 * same way. `@id` or `url` is the `sourceId`, the type comes from keywords
 * with `other` as the fallback, and times are sent with an explicit offset.
 * Only Event fields are read: `performer`, `organizer` and `attendee` nodes
 * are never mapped, and past or cancelled events are dropped.
 */
import type { EventItem } from '../../src/services/ingest.js';
import type { EventSource } from './events-ics.js';
import {
  argValue,
  dataPath,
  isMain,
  postIngest,
  readJson,
  runScript,
  type ScriptContext,
  scriptContext,
} from './lib/client.js';
import {
  cleanText,
  eventTypeFromText,
  normalizeDateString,
  splitLocation,
  stableId,
} from './lib/events.js';
import { fetchAllowed } from './lib/http.js';

type JsonObject = Record<string, unknown>;

const SCRIPT_RE =
  /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const HREF_RE = /href\s*=\s*["']([^"'#]+)["']/gi;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = DAY_MS;
const STALE_LINK_MS = 30 * DAY_MS;
export const MAX_DETAIL_PAGES = 50;
const CRAWL_PACE_MS = 1000;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typesOf(node: JsonObject): string[] {
  const t = node['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function isEventNode(node: JsonObject): boolean {
  return typesOf(node).some(
    (t) => t === 'Event' || t === 'Festival' || (t.endsWith('Event') && t !== 'PublicationEvent'),
  );
}

/** Walk arrays, `@graph`, and `subEvent` lists; events nested deeper than that are ignored. */
function collectEventNodes(root: unknown, depth = 0, out: JsonObject[] = []): JsonObject[] {
  if (depth > 4) return out;
  if (Array.isArray(root)) {
    for (const entry of root) collectEventNodes(entry, depth + 1, out);
    return out;
  }
  if (!isObject(root)) return out;
  if (isEventNode(root)) out.push(root);
  for (const key of ['@graph', 'subEvent', 'itemListElement', 'item']) {
    if (key in root) collectEventNodes(root[key], depth + 1, out);
  }
  return out;
}

export function parseJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_RE)) {
    const raw = (match[1] as string).trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // A page with one broken block still yields the others.
    }
  }
  return blocks;
}

function addressText(address: unknown): string {
  if (typeof address === 'string') return cleanText(address, 240);
  if (!isObject(address)) return '';
  const parts = [
    address.streetAddress,
    address.addressLocality,
    [address.addressRegion, address.postalCode].filter(Boolean).join(' '),
  ]
    .map((p) => (typeof p === 'string' ? cleanText(p, 120) : ''))
    .filter(Boolean);
  return parts.join(', ').slice(0, 240);
}

function placeOf(node: JsonObject): Pick<EventItem, 'venueName' | 'address' | 'location'> {
  const loc = Array.isArray(node.location) ? node.location[0] : node.location;
  if (typeof loc === 'string') {
    const where = splitLocation(cleanText(loc, 400));
    return { venueName: where.venueName || undefined, address: where.address || undefined };
  }
  if (!isObject(loc)) return {};
  const geo = isObject(loc.geo) ? loc.geo : undefined;
  const lat = Number(geo?.latitude);
  const lng = Number(geo?.longitude);
  const location =
    geo &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
      ? { lng, lat }
      : undefined;
  const venueName = typeof loc.name === 'string' ? cleanText(loc.name, 120) : '';
  const address = addressText(loc.address);
  return {
    venueName: venueName || undefined,
    address: address || undefined,
    location,
  };
}

function absoluteUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim(), base);
    return /^https?:$/.test(url.protocol) ? url.toString().slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function nodeToItem(
  node: JsonObject,
  pageUrl: string,
  src: EventSource,
  now: Date,
): EventItem | null {
  const status = typeof node.eventStatus === 'string' ? node.eventStatus : '';
  if (/Cancelled/i.test(status)) return null;
  const title = cleanText(typeof node.name === 'string' ? node.name : '', 140);
  const startsAt = normalizeDateString(node.startDate);
  if (!title || !startsAt) return null;
  const endsAt = normalizeDateString(node.endDate) ?? undefined;
  if (endsAt && endsAt < startsAt) return null;
  if (new Date(endsAt ?? startsAt).getTime() < now.getTime() - PAST_GRACE_MS) return null;
  const description = cleanText(typeof node.description === 'string' ? node.description : '', 4000);
  const url = absoluteUrl(node.url, pageUrl);
  const id = typeof node['@id'] === 'string' && node['@id'].trim() ? node['@id'] : undefined;
  return {
    sourceId: stableId(id ?? url ?? `${title}|${startsAt}`),
    title,
    type: eventTypeFromText(`${title} ${description}`),
    startsAt,
    endsAt,
    ...placeOf(node),
    hostName: src.hostName,
    description: description || undefined,
    sourceUrl: url ?? pageUrl,
  };
}

/** Map one page's HTML to ingest items. Exported for the tests. */
export function extractJsonLdEvents(
  html: string,
  pageUrl: string,
  src: EventSource,
  now: Date = new Date(),
): EventItem[] {
  const seen = new Set<string>();
  const items: EventItem[] = [];
  for (const node of parseJsonLdBlocks(html).flatMap((b) => collectEventNodes(b))) {
    const item = nodeToItem(node, pageUrl, src, now);
    if (!item || seen.has(item.sourceId)) continue;
    seen.add(item.sourceId);
    items.push(item);
  }
  return items;
}

/** A `/yyyy/m/d/` date in a path, when the site puts one there, so stale pages are skipped. */
function pathDate(pathname: string): Date | null {
  const match = /\/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/.exec(pathname);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Same-origin links on a list page that match the source's detail pattern,
 * de-duplicated, without query strings (Squarespace's `?format=ical` links
 * are disallowed by its robots.txt), capped. Exported for the tests.
 */
export function collectDetailLinks(
  html: string,
  pageUrl: string,
  pattern: string,
  now: Date = new Date(),
): string[] {
  const origin = new URL(pageUrl).origin;
  const re = new RegExp(pattern);
  const links = new Set<string>();
  for (const match of html.matchAll(HREF_RE)) {
    let url: URL;
    try {
      url = new URL((match[1] as string).trim(), pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== origin || url.search || !re.test(url.pathname)) continue;
    const dated = pathDate(url.pathname);
    if (dated && dated.getTime() < now.getTime() - STALE_LINK_MS) continue;
    links.add(`${url.origin}${url.pathname}`);
    if (links.size >= MAX_DETAIL_PAGES) break;
  }
  return Array.from(links);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function crawlSource(ctx: ScriptContext, src: EventSource): Promise<EventItem[]> {
  const pageUrl = src.url as string;
  const html = await fetchAllowed(pageUrl);
  const items = extractJsonLdEvents(html, pageUrl, src);
  if (!src.detailLinkPattern) return items;

  const links = collectDetailLinks(html, pageUrl, src.detailLinkPattern);
  ctx.logger.info({ source: src.source, detailPages: links.length }, 'crawling detail pages');
  const seen = new Set(items.map((i) => i.sourceId));
  for (const link of links) {
    await sleep(CRAWL_PACE_MS);
    try {
      for (const item of extractJsonLdEvents(await fetchAllowed(link), link, src)) {
        if (seen.has(item.sourceId)) continue;
        seen.add(item.sourceId);
        items.push(item);
      }
    } catch (err) {
      ctx.logger.warn({ source: src.source, err }, 'detail page skipped');
    }
  }
  return items;
}

async function main(): Promise<void> {
  const ctx = scriptContext();
  const file = dataPath(argValue(ctx.args, 'input') ?? 'event-sources.json');
  const sources = readJson<EventSource[]>(file).filter((s) => s.url && !s.placeholder);
  ctx.logger.info({ file, pages: sources.length }, 'json-ld sources');

  for (const src of sources) {
    try {
      const items = await crawlSource(ctx, src);
      ctx.logger.info({ source: src.source, items: items.length }, 'mapped');
      await postIngest(ctx, 'events', src.source, items);
    } catch (err) {
      ctx.logger.error({ source: src.source, err }, 'page failed');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) runScript(main);
