/**
 * Helpers shared by the event scripts: the keyword-to-type map, text cleanup
 * for HTML-bearing descriptions, and time handling. Feeds and pages from
 * Southern California organizations often carry local times without a zone;
 * those are read as America/Los_Angeles and sent with an explicit offset,
 * which is what the ingest contract requires.
 */
import { createHash } from 'node:crypto';
import type { EVENT_TYPES } from '../../../src/models/enums.js';

export type EventType = (typeof EVENT_TYPES)[number];

export const DEFAULT_ZONE = 'America/Los_Angeles';

/** Checked in order; the first pattern that matches wins, `other` when none does. */
const TYPE_PATTERNS: Array<[RegExp, EventType]> = [
  [/\b(protest|demonstration|march|rally|picket)\b/i, 'protest'],
  [/\b(vigil|bear witness|save movement)\b/i, 'vigil'],
  [/\b(screening|film night|movie night|documentary)\b/i, 'screening'],
  [/\b(outreach|cube of truth|leaflet\w*|tabling|street action|activism)\b/i, 'outreach'],
  [/\b(potluck|dinner|brunch|picnic|feast|thanksliving|celebration for the)\b/i, 'potluck'],
  [/\b(meeting|orientation|training|workshop|webinar|planning|chapter call)\b/i, 'meeting'],
  [/\b(sanctuary|tour|volunteer\w*|work ?day|open house|farm day|barn)\b/i, 'sanctuary_day'],
];

/** The first keyword type that matches, or null when none does. */
export function matchEventType(text: string): EventType | null {
  for (const [pattern, type] of TYPE_PATTERNS) if (pattern.test(text)) return type;
  return null;
}

export function eventTypeFromText(text: string): EventType {
  return matchEventType(text) ?? 'other';
}

/** Keyword inference, else the allowlist entry's `defaultType`, else `other`. */
export function inferEventType(text: string, src: { defaultType?: EventType }): EventType {
  return matchEventType(text) ?? src.defaultType ?? 'other';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '...',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

/** Decode twice (feeds often double-encode), strip tags, collapse whitespace, cap length. */
export function cleanText(text: string | undefined | null, max: number): string {
  if (!text) return '';
  const decoded = decodeEntities(decodeEntities(text));
  return stripHtml(decoded)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, max);
}

/** An IANA zone a feed named, when the runtime knows it; America/Los_Angeles otherwise. */
export function zoneOrDefault(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** Offset of `zone` at the given instant, in minutes east of UTC. */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(instant)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? '0'));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-11-21T18:00:00-08:00` for an instant, expressed in the given offset. */
export function formatWithOffset(instant: Date, offsetMinutes: number): string {
  const shifted = new Date(instant.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${shifted.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function toIsoInZone(instant: Date, zone: string = DEFAULT_ZONE): string {
  return formatWithOffset(instant, zoneOffsetMinutes(instant, zone));
}

/**
 * A wall-clock time with no zone (`2026-11-21T18:00:00`, or a bare date) read
 * as local time in `zone`. The offset is evaluated twice so a time on the
 * far side of a DST change still lands on the right instant.
 */
export function localToIso(local: string, zone: string = DEFAULT_ZONE): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(local.trim());
  if (!match) return null;
  const wall = `${match[1]}T${match[2] ?? '00'}:${match[3] ?? '00'}:${match[4] ?? '00'}`;
  const guess = new Date(`${wall}Z`);
  if (Number.isNaN(guess.getTime())) return null;
  const first = zoneOffsetMinutes(guess, zone);
  const instant = new Date(guess.getTime() - first * 60_000);
  const offset = zoneOffsetMinutes(instant, zone);
  return formatWithOffset(new Date(guess.getTime() - offset * 60_000), offset);
}

/** Any date string a feed might use to the ISO-with-offset form the API wants. */
export function normalizeDateString(value: unknown, zone: string = DEFAULT_ZONE): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text) && /\dT\d/.test(text)) {
    const instant = new Date(text);
    return Number.isNaN(instant.getTime()) ? null : toIsoInZone(instant, zone);
  }
  return localToIso(text, zone);
}

/** `"Animal Place, 17314 McCourtney Rd, Grass Valley, CA"` -> venue and the rest as address. */
export function splitLocation(text: string): { venueName: string; address: string } {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { venueName: '', address: '' };
  const first = parts[0] as string;
  if (/\d/.test(first)) return { venueName: '', address: parts.join(', ').slice(0, 240) };
  return { venueName: first.slice(0, 120), address: parts.slice(1).join(', ').slice(0, 240) };
}

/**
 * A point the API accepts from whatever a feed put in its lat/lng fields
 * (numbers or numeric strings). `0,0` is how APIs say "unknown", never a
 * Southern California venue, so it is treated as absent.
 */
export function pointOf(lat: unknown, lng: unknown): { lng: number; lat: number } | undefined {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return undefined;
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return undefined;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180 || (la === 0 && ln === 0)) return undefined;
  return { lng: ln, lat: la };
}

/** A stable id no longer than the schema allows; long ids are hashed. */
export function stableId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 200) return trimmed;
  return `sha1:${createHash('sha1').update(trimmed).digest('hex')}`;
}
