/**
 * Ingest events from schema.org `Event` JSON-LD on allowlisted pages, then
 * POST them to `/api/ingest/events`.
 *
 *   npm run ingest:events:jsonld -- --dry-run          # fetch, map, print counts
 *   npm run ingest:events:jsonld                       # POST with INGEST_KEY to API_URL
 *   npm run ingest:events:jsonld -- --input other.json # a different source list
 *
 * Source list: scripts/data/event-sources.json, entries shaped
 * `{ source, hostName, url, detailLinkPattern?, maxPages? }` plus the
 * optional fields in lib/sources.ts; entries with `enabled: false`, a
 * `placeholder` note or no `url` are skipped. The list page is fetched once
 * after robots.txt with a descriptive User-Agent. Every
 * `<script type="application/ld+json">` is parsed; plain objects, arrays and
 * `@graph` are walked and anything typed `Event` (or a subtype such as
 * `SocialEvent`) becomes an item.
 *
 * Squarespace, Wix and calendar aggregators put the Event JSON-LD on each
 * event's detail page, not the list. For those, `detailLinkPattern` is a
 * regex matched against the path of same-origin links on the list page,
 * query string stripped (a listing's `?referrer=` tracking is dropped; the
 * `?format=ical` and `?format=json` variants Squarespace's robots.txt
 * disallows are never followed). The matching pages (at most `maxPages`,
 * capped at 50, one request per second, robots.txt respected on each, links
 * whose path carries a date more than a month old skipped) are fetched and
 * mined the same way. `@id` or `url` is the `sourceId`, the type comes from
 * keywords with the entry's `defaultType` then `other` as the fallback, and
 * times are sent with an explicit offset. Only Event fields are read:
 * `performer`, `organizer` and `attendee` nodes are never mapped, and past
 * or cancelled events and titles a `titleFilter` rejects are dropped.
 */
import type { EventItem } from '../../src/services/ingest.js';
import { isMain, postIngest, runScript, type ScriptContext, scriptContext } from './lib/client.js';
import {
  cleanText,
  inferEventType,
  normalizeDateString,
  pointOf,
  splitLocation,
  stableId,
} from './lib/events.js';
import { fetchAllowed } from './lib/http.js';
import { isObject, type JsonObject } from './lib/json.js';
import { type EventSource, keepsTitle, loadSources } from './lib/sources.js';

const SCRIPT_RE =
  /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const HREF_RE = /href\s*=\s*["']([^"'#]+)["']/gi;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = DAY_MS;
const STALE_LINK_MS = 30 * DAY_MS;
export const MAX_DETAIL_PAGES = 50;

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
  const venueName = typeof loc.name === 'string' ? cleanText(loc.name, 120) : '';
  const address = addressText(loc.address);
  return {
    venueName: venueName || undefined,
    address: address || undefined,
    location: geo ? pointOf(geo.latitude, geo.longitude) : undefined,
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

/** Start and end for a node that is neither cancelled nor long past; null otherwise. */
function eventWindow(node: JsonObject, now: Date): { startsAt: string; endsAt?: string } | null {
  const status = typeof node.eventStatus === 'string' ? node.eventStatus : '';
  if (/Cancelled/i.test(status)) return null;
  const startsAt = normalizeDateString(node.startDate);
  if (!startsAt) return null;
  const endsAt = normalizeDateString(node.endDate) ?? undefined;
  if (endsAt && endsAt < startsAt) return null;
  if (new Date(endsAt ?? startsAt).getTime() < now.getTime() - PAST_GRACE_MS) return null;
  return { startsAt, endsAt };
}

function nodeToItem(
  node: JsonObject,
  pageUrl: string,
  src: EventSource,
  now: Date,
): EventItem | null {
  const window = eventWindow(node, now);
  const title = cleanText(typeof node.name === 'string' ? node.name : '', 140);
  if (!window || !title || !keepsTitle(src, title)) return null;
  const description = cleanText(typeof node.description === 'string' ? node.description : '', 4000);
  const url = absoluteUrl(node.url, pageUrl);
  const id = typeof node['@id'] === 'string' && node['@id'].trim() ? node['@id'] : undefined;
  return {
    sourceId: stableId(id ?? url ?? `${title}|${window.startsAt}`),
    title,
    type: inferEventType(`${title} ${description}`, src),
    ...window,
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

/** Squarespace's per-event feed links; robots.txt disallows them and they are never pages. */
function isFeedVariant(url: URL): boolean {
  return /^(ical|json)$/i.test(url.searchParams.get('format') ?? '');
}

/** The entry's `maxPages` when it lowers the crawl cap; the cap otherwise. */
export function detailPageLimit(src: Pick<EventSource, 'maxPages'>): number {
  const wanted = Math.floor(src.maxPages ?? MAX_DETAIL_PAGES);
  return Math.min(MAX_DETAIL_PAGES, Math.max(1, Number.isFinite(wanted) ? wanted : 1));
}

/**
 * Same-origin links on a list page whose path matches the source's detail
 * pattern, de-duplicated with the query string stripped (a listing's
 * `?referrer=` tracking is dropped; `?format=ical` and `?format=json`
 * variants are never followed), capped. Exported for the tests.
 */
export function collectDetailLinks(
  html: string,
  pageUrl: string,
  pattern: string,
  now: Date = new Date(),
  limit: number = MAX_DETAIL_PAGES,
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
    if (url.origin !== origin || isFeedVariant(url) || !re.test(url.pathname)) continue;
    const dated = pathDate(url.pathname);
    if (dated && dated.getTime() < now.getTime() - STALE_LINK_MS) continue;
    links.add(`${url.origin}${url.pathname}`);
    if (links.size >= limit) break;
  }
  return Array.from(links);
}

async function crawlSource(ctx: ScriptContext, src: EventSource, pageUrl: string) {
  const html = await fetchAllowed(pageUrl);
  const items = extractJsonLdEvents(html, pageUrl, src);
  if (!src.detailLinkPattern) return items;

  const limit = detailPageLimit(src);
  const links = collectDetailLinks(html, pageUrl, src.detailLinkPattern, new Date(), limit);
  ctx.logger.info(
    { source: src.source, detailPages: links.length, limit },
    'crawling detail pages',
  );
  const seen = new Set(items.map((i) => i.sourceId));
  for (const link of links) {
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
  for (const src of loadSources(ctx, 'jsonld')) {
    if (!src.url) {
      ctx.logger.warn({ source: src.source }, 'no url; skipped');
      continue;
    }
    try {
      const items = await crawlSource(ctx, src, src.url);
      ctx.logger.info({ source: src.source, items: items.length }, 'mapped');
      await postIngest(ctx, 'events', src.source, items);
    } catch (err) {
      ctx.logger.error({ source: src.source, err }, 'page failed');
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) runScript(main);
