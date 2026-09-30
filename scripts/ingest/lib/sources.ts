/**
 * The event allowlist, `scripts/data/event-sources.json`, and what every
 * event script reads from it. One entry is one organization's feed, page,
 * API or JSON file; `kind` picks the script (inferred from `ics` or `url`
 * for the round-1 entries that predate the field). `enabled: false` parks
 * an entry with its `decision` note until a person makes the call, and a
 * `placeholder` note tracks a source that publishes nothing usable yet; both
 * are skipped with a log line. `titleFilter` keeps only events whose title
 * matches, for calendars that mix vegan events with others. `trust`,
 * `scope`, `verified`, `decision` and `notes` are documentation: the
 * moderation tier is decided by TRUSTED_SOURCES on the API, never here.
 */
import { argValue, dataPath, readJson, type ScriptContext } from './client.js';
import type { EventType } from './events.js';

export const SOURCE_KINDS = ['ics', 'jsonld', 'mobilize', 'tribe', 'json', 'dxe'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface EventSource {
  source: string;
  hostName: string;
  kind?: SourceKind;
  /** ICS feed URL (`ics`). */
  ics?: string;
  /** List page (`jsonld`), REST endpoint (`tribe`) or static file (`json`). */
  url?: string;
  /** Regex (as a string) for same-origin detail links on a list page that carry the Event JSON-LD. */
  detailLinkPattern?: string;
  /** Detail pages fetched per list page (`jsonld`); never above the crawl cap. */
  maxPages?: number;
  /** Regex (as a string, case-insensitive) an event title must match to be kept. */
  titleFilter?: string;
  /** The type used when nothing in the title infers one; `other` when absent. */
  defaultType?: EventType;
  /** `false` parks the entry: every script skips it and says so. */
  enabled?: boolean;
  /** Mobilize organization id (`mobilize`). */
  organizationId?: number;
  organizationSlug?: string;
  /** DxE chapter page id (`dxe`), digits only. */
  pageId?: number | string;
  /** Named mapper for a static JSON file (`json`). */
  mapping?: string;
  /** `any` keeps events outside California (`json`); the default keeps California only. */
  region?: 'ca' | 'any';
  /** The organization's public events page: the link when an event has none of its own. */
  sourceUrl?: string;
  /** Entries kept for tracking but not fetched. */
  placeholder?: string;
  /** Documentation only. */
  verified?: string;
  trust?: string;
  scope?: string;
  decision?: string;
  notes?: string;
  icsFallback?: string;
}

/** Entries kept for tracking but not fetched: a `placeholder` note, or a verified note that says so. */
export function isPlaceholder(src: EventSource): boolean {
  return Boolean(src.placeholder) || /placeholder/i.test(src.verified ?? '');
}

/** The script an entry belongs to. Round-1 entries carry no `kind`; `ics` or `url` decides. */
export function kindOf(src: EventSource): SourceKind | undefined {
  if (src.kind) return src.kind;
  if (src.ics) return 'ics';
  if (src.url) return 'jsonld';
  return undefined;
}

export type SkipReason = 'disabled' | 'placeholder';

export interface SourceSelection {
  selected: EventSource[];
  skipped: Array<{ source: string; reason: SkipReason }>;
}

/** The entries one script should fetch, and the ones of its kind it must skip, with the reason. */
export function selectSources(all: EventSource[], kind: SourceKind): SourceSelection {
  const selection: SourceSelection = { selected: [], skipped: [] };
  for (const src of all) {
    if (kindOf(src) !== kind) continue;
    if (src.enabled === false) selection.skipped.push({ source: src.source, reason: 'disabled' });
    else if (isPlaceholder(src))
      selection.skipped.push({ source: src.source, reason: 'placeholder' });
    else selection.selected.push(src);
  }
  return selection;
}

/** Read the allowlist (`--input` overrides the file), log every skip, return the entries to fetch. */
export function loadSources(ctx: ScriptContext, kind: SourceKind): EventSource[] {
  const file = dataPath(argValue(ctx.args, 'input') ?? 'event-sources.json');
  const { selected, skipped } = selectSources(readJson<EventSource[]>(file), kind);
  for (const skip of skipped) {
    ctx.logger.info({ source: skip.source, reason: skip.reason }, 'source skipped');
  }
  ctx.logger.info({ file, kind, sources: selected.length }, 'event sources');
  return selected;
}

/** The compiled `titleFilter`, or null when the entry has none. Throws on a bad pattern. */
export function titleFilterOf(src: EventSource): RegExp | null {
  return src.titleFilter ? new RegExp(src.titleFilter, 'i') : null;
}

/** True unless the entry has a `titleFilter` the title does not match. */
export function keepsTitle(src: EventSource, title: string): boolean {
  const filter = titleFilterOf(src);
  return filter === null || filter.test(title);
}
