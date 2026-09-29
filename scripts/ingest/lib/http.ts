/**
 * Polite fetching for the scrapers: a descriptive User-Agent, a timeout, and
 * robots.txt honoured before any page or feed is read. The ingest contract
 * never scrapes Facebook, Instagram, Meetup or Eventbrite; those hosts are
 * refused here outright so a config typo cannot reach them.
 */
import { INGEST_USER_AGENT, ROBOTS_TOKEN } from './client.js';

const FORBIDDEN_HOSTS = ['facebook.com', 'instagram.com', 'meetup.com', 'eventbrite.com'];

export function isForbiddenHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return FORBIDDEN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** The subset of robots.txt that matters: groups, Allow, Disallow, longest match wins. */
export class RobotsRules {
  private readonly groups: RobotsGroup[] = [];

  constructor(text: string) {
    let current: RobotsGroup | null = null;
    let lastWasAgent = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      const field = (match[1] as string).toLowerCase();
      const value = (match[2] as string).trim();
      if (field === 'user-agent') {
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [] };
          this.groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!current) continue;
      if (field === 'allow' || field === 'disallow') {
        current.rules.push({ allow: field === 'allow', pattern: value });
      }
    }
  }

  private groupFor(token: string): RobotsGroup | undefined {
    const wanted = token.toLowerCase();
    const specific = this.groups.filter((g) =>
      g.agents.some((a) => a !== '*' && (wanted.includes(a) || a.includes(wanted))),
    );
    if (specific.length > 0) return { agents: [wanted], rules: specific.flatMap((g) => g.rules) };
    const wildcard = this.groups.filter((g) => g.agents.includes('*'));
    return wildcard.length > 0
      ? { agents: ['*'], rules: wildcard.flatMap((g) => g.rules) }
      : undefined;
  }

  allows(pathname: string, token: string = ROBOTS_TOKEN): boolean {
    const group = this.groupFor(token);
    if (!group) return true;
    let best: { allow: boolean; length: number } | null = null;
    for (const rule of group.rules) {
      if (rule.pattern === '') continue;
      if (!patternToRegex(rule.pattern).test(pathname)) continue;
      const length = rule.pattern.length;
      if (!best || length > best.length || (length === best.length && rule.allow)) {
        best = { allow: rule.allow, length };
      }
    }
    return best ? best.allow : true;
  }
}

const robotsCache = new Map<string, RobotsRules>();

async function robotsFor(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let rules = new RobotsRules('');
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': INGEST_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) rules = new RobotsRules(await res.text());
  } catch {
    // Unreachable robots.txt is treated as absent, per the usual convention.
  }
  robotsCache.set(origin, rules);
  return rules;
}

export async function robotsAllows(url: string): Promise<boolean> {
  const u = new URL(url);
  const rules = await robotsFor(u.origin);
  return rules.allows(`${u.pathname}${u.search}`);
}

export interface FetchOptions {
  accept?: string;
  timeoutMs?: number;
}

/** Fetch a page or feed as text after the host and robots.txt checks. */
export async function fetchAllowed(url: string, options: FetchOptions = {}): Promise<string> {
  if (isForbiddenHost(url)) throw new Error(`refusing to fetch ${new URL(url).hostname}`);
  if (!(await robotsAllows(url))) throw new Error(`robots.txt disallows ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': INGEST_USER_AGENT, Accept: options.accept ?? 'text/html,*/*' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}
