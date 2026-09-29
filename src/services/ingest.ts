import type { AnyBulkWriteOperation, Model, QueryFilter } from 'mongoose';
import { z } from 'zod';
import { areaForPoint, cityForArea } from '../lib/areas.js';
import { describePlace } from '../lib/placeDescription.js';
import { pointInput } from '../lib/schemas.js';
import { slugify } from '../lib/slug.js';
import {
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  EventModel,
  GUIDE_CATEGORIES,
  GuideModel,
  HOME_AREAS,
  type HomeArea,
  type IngestResource,
  MEDIA_KINDS,
  MediaItemModel,
  ORGANIZATION_TYPES,
  OrganizationModel,
  PLACE_TYPES,
  PlaceModel,
  Types,
  VEGAN_LEVELS,
} from '../models/index.js';

/**
 * The ingest contract (spec section 9): validated items from a named source
 * are upserted by `(source, sourceId)`. New rows land in the moderation
 * queue unless the source is trusted; a re-ingest never moves a moderated
 * row backwards and never overwrites a field an admin edited by hand.
 *
 * Nothing here knows about the caller. The route decides who may call and
 * whether the source is trusted; the OSM importers call this directly.
 */

const DEFAULT_EVENT_HOURS = 2;

const sourceIdSchema = z.string().trim().min(1).max(200);
const urlSchema = z.url().max(500);
const tagsSchema = z.array(z.string().trim().min(1).max(60)).max(30);
const isoWithOffset = z.iso.datetime({ offset: true });

export const placeItemSchema = z
  .object({
    sourceId: sourceIdSchema,
    name: z.string().trim().min(1).max(120),
    type: z.enum(PLACE_TYPES),
    veganLevel: z.enum(VEGAN_LEVELS),
    location: pointInput,
    address: z.string().trim().max(240).optional(),
    city: z.string().trim().max(80).optional(),
    postcode: z.string().trim().max(16).optional(),
    website: urlSchema.optional(),
    phone: z.string().trim().max(40).optional(),
    hours: z.string().trim().max(200).optional(),
    tags: tagsSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    chain: z.boolean().optional(),
    sourceUrl: urlSchema.optional(),
  })
  .strict();

export const eventItemSchema = z
  .object({
    sourceId: sourceIdSchema,
    title: z.string().trim().min(1).max(140),
    type: z.enum(EVENT_TYPES),
    startsAt: isoWithOffset,
    endsAt: isoWithOffset.optional(),
    venueName: z.string().trim().max(120).optional(),
    address: z.string().trim().max(240).optional(),
    location: pointInput.optional(),
    detailsAfterRsvp: z.boolean().optional(),
    hostName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000).optional(),
    sourceUrl: urlSchema,
    visibility: z.enum(EVENT_VISIBILITIES).optional(),
  })
  .strict()
  .refine((e) => !e.endsAt || new Date(e.endsAt) >= new Date(e.startsAt), {
    message: 'endsAt must not be before startsAt',
    path: ['endsAt'],
  });

const socialsSchema = z
  .object({
    instagram: z.string().trim().max(200).optional(),
    facebook: z.string().trim().max(200).optional(),
    bluesky: z.string().trim().max(200).optional(),
    mastodon: z.string().trim().max(200).optional(),
    tiktok: z.string().trim().max(200).optional(),
    youtube: z.string().trim().max(200).optional(),
  })
  .strict();

export const organizationItemSchema = z
  .object({
    sourceId: sourceIdSchema,
    name: z.string().trim().min(1).max(120),
    type: z.enum(ORGANIZATION_TYPES),
    description: z.string().trim().max(4000).optional(),
    website: urlSchema.optional(),
    socials: socialsSchema.optional(),
    area: z.enum(HOME_AREAS).optional(),
    sourceUrl: urlSchema.optional(),
  })
  .strict();

export const mediaItemSchema = z
  .object({
    sourceId: sourceIdSchema,
    title: z.string().trim().min(1).max(160),
    kind: z.enum(MEDIA_KINDS),
    year: z.number().int().min(1900).max(2100).optional(),
    synopsis: z.string().trim().max(4000).optional(),
    // An S3 key the script already uploaded: path segments and an image extension, no `..`.
    posterKey: z
      .string()
      .max(200)
      .regex(/^(?!.*\.\.)[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(jpg|jpeg|png|webp)$/)
      .optional(),
    watchLinks: z
      .array(z.object({ provider: z.string().trim().min(1).max(60), url: urlSchema }).strict())
      .max(20)
      .optional(),
    trailerYoutubeId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{6,20}$/)
      .optional(),
    tags: tagsSchema.optional(),
    externalIds: z
      .object({
        tmdb: z
          .string()
          .regex(/^\d{1,20}$/)
          .optional(),
        wikidata: z
          .string()
          .regex(/^Q\d{1,19}$/)
          .optional(),
        imdb: z
          .string()
          .regex(/^tt\d{1,18}$/)
          .optional(),
      })
      .strict()
      .optional(),
    sourceUrl: urlSchema.optional(),
  })
  .strict();

export const guideItemSchema = z
  .object({
    sourceId: sourceIdSchema,
    title: z.string().trim().min(1).max(160),
    category: z.enum(GUIDE_CATEGORIES),
    body: z.string().min(1).max(200_000),
    summary: z.string().trim().max(500).optional(),
    sources: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            url: urlSchema,
            license: z.string().trim().max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    sourceUrl: urlSchema.optional(),
  })
  .strict();

export type PlaceItem = z.infer<typeof placeItemSchema>;
export type EventItem = z.infer<typeof eventItemSchema>;
export type OrganizationItem = z.infer<typeof organizationItemSchema>;
export type MediaItemInput = z.infer<typeof mediaItemSchema>;
export type GuideItem = z.infer<typeof guideItemSchema>;

export const ITEM_SCHEMAS: Record<IngestResource, z.ZodType> = {
  places: placeItemSchema,
  events: eventItemSchema,
  organizations: organizationItemSchema,
  media: mediaItemSchema,
  guides: guideItemSchema,
};

/**
 * Keys that would carry a person. Rejected before schema validation so the
 * error says why, not just "unrecognized key". `phone` is a business line on
 * a place and personal everywhere else.
 */
const PERSONAL_KEYS = new Set([
  'email',
  'emails',
  'attendees',
  'attendeelist',
  'members',
  'memberlist',
  'rsvps',
  'guests',
  'participants',
  'contact',
  'contactemail',
  'contactphone',
  'phonenumber',
  'organizeremail',
  'organizerphone',
]);

function personalDataErrors(resource: IngestResource, item: unknown): string[] {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  const errors: string[] = [];
  for (const key of Object.keys(item)) {
    const lower = key.toLowerCase();
    if (PERSONAL_KEYS.has(lower) || (lower === 'phone' && resource !== 'places')) {
      errors.push(`${key}: personal data is not accepted`);
    }
  }
  return errors;
}

export interface RejectedItem {
  index: number;
  sourceId: string | null;
  errors: string[];
}

export interface IngestResult {
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: RejectedItem[];
}

export interface IngestOptions {
  /** Trusted sources land approved / published / verified and promote pending rows. */
  trusted: boolean;
  /**
   * Organizations only: a row auto-created from an event's `hostName` is a
   * stub (`sourceId` starts with `host:`). A curated item with the same slug
   * adopts it, filling the fields and taking over its provenance, instead of
   * inserting a duplicate.
   */
  adoptStubs?: boolean;
}

export const HOST_STUB_PREFIX = 'host:';

/** One validated item, ready to become a row. `set` is what the source owns. */
interface PreparedRow {
  sourceId: string;
  slugBase: string;
  set: Record<string, unknown>;
  insertOnly: Record<string, unknown>;
}

interface Moderation {
  field: string;
  pending: unknown;
  approved: unknown;
}

interface ExistingRow extends Record<string, unknown> {
  _id: Types.ObjectId;
  sourceId: string;
  adminEdited?: string[];
}

const MODERATION: Record<IngestResource, Moderation> = {
  places: { field: 'approvalStatus', pending: 'pending', approved: 'approved' },
  events: { field: 'status', pending: 'pending', approved: 'published' },
  organizations: { field: 'verified', pending: false, approved: true },
  media: { field: 'status', pending: 'draft', approved: 'published' },
  guides: { field: 'status', pending: 'draft', approved: 'published' },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Types.ObjectId)
  );
}

/** Structural equality over what Mongoose hands back from `lean()`. */
export function isSameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Types.ObjectId || b instanceof Types.ObjectId) return String(a) === String(b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => isSameValue(v, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => isSameValue(a[k], b[k]));
  }
  return a === b;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Slugs for new rows: the plain slug, else `-2`, `-3`, ... never touching existing slugs. */
async function allocateSlugs<T>(model: Model<T>, bases: string[]): Promise<string[]> {
  if (bases.length === 0) return [];
  const pattern = `^(${Array.from(new Set(bases)).map(escapeRegex).join('|')})(-\\d+)?$`;
  const rows = await model
    .find({ slug: { $regex: pattern } } as QueryFilter<T>)
    .select('slug')
    .lean<Array<{ slug: string }>>();
  const taken = new Set(rows.map((r) => r.slug));
  return bases.map((base) => {
    let slug = base;
    let n = 2;
    while (taken.has(slug)) slug = `${base}-${n++}`;
    taken.add(slug);
    return slug;
  });
}

function insertOp(
  row: PreparedRow,
  slug: string | undefined,
  source: string,
  moderation: Moderation,
  trusted: boolean,
  now: Date,
): AnyBulkWriteOperation<Record<string, unknown>> {
  return {
    insertOne: {
      document: {
        ...row.insertOnly,
        ...compact(row.set),
        slug,
        source,
        sourceId: row.sourceId,
        lastSeenAt: now,
        adminEdited: [],
        [moderation.field]: trusted ? moderation.approved : moderation.pending,
      },
    },
  };
}

/**
 * What a re-ingest may change on an existing row: source-owned fields whose
 * value differs, minus anything an admin edited, plus the forward moderation
 * move for a trusted source. Empty means the row is unchanged.
 */
function diffRow(
  found: ExistingRow,
  row: PreparedRow,
  moderation: Moderation,
  trusted: boolean,
): Record<string, unknown> {
  const locked = new Set(found.adminEdited ?? []);
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.set)) {
    if (value === undefined || locked.has(key)) continue;
    if (!isSameValue(found[key], value)) changes[key] = value;
  }
  const canPromote = trusted && !locked.has(moderation.field);
  if (canPromote && isSameValue(found[moderation.field], moderation.pending)) {
    changes[moderation.field] = moderation.approved;
  }
  return changes;
}

/** Host stubs whose slug matches a fresh row, keyed by that row's `sourceId`. */
async function findStubs<T>(
  model: Model<T>,
  fresh: PreparedRow[],
): Promise<Map<string, ExistingRow>> {
  if (fresh.length === 0) return new Map();
  const stubs = await model
    .find({
      slug: { $in: fresh.map((r) => r.slugBase) },
      sourceId: { $regex: `^${HOST_STUB_PREFIX}` },
    } as QueryFilter<T>)
    .lean<Array<ExistingRow & { slug: string }>>();
  const bySlug = new Map(stubs.map((s) => [s.slug, s]));
  const out = new Map<string, ExistingRow>();
  for (const row of fresh) {
    const stub = bySlug.get(row.slugBase);
    if (stub) out.set(row.sourceId, stub);
  }
  return out;
}

async function applyUpserts<T>(
  model: Model<T>,
  source: string,
  rows: PreparedRow[],
  moderation: Moderation,
  options: IngestOptions,
): Promise<Omit<IngestResult, 'rejected'>> {
  const now = new Date();
  const existing = await model
    .find({ source, sourceId: { $in: rows.map((r) => r.sourceId) } } as QueryFilter<T>)
    .lean<ExistingRow[]>();
  const current = new Map(existing.map((e) => [e.sourceId, e]));
  const adopted = options.adoptStubs
    ? await findStubs(
        model,
        rows.filter((r) => !current.has(r.sourceId)),
      )
    : new Map<string, ExistingRow>();
  const fresh = rows.filter((r) => !current.has(r.sourceId) && !adopted.has(r.sourceId));
  const slugs = await allocateSlugs(
    model,
    fresh.map((r) => r.slugBase),
  );

  const ops: AnyBulkWriteOperation<Record<string, unknown>>[] = [];
  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  let freshIndex = 0;

  for (const row of rows) {
    const stub = adopted.get(row.sourceId);
    const found = current.get(row.sourceId) ?? stub;
    if (!found) {
      ops.push(insertOp(row, slugs[freshIndex++], source, moderation, options.trusted, now));
      counts.inserted += 1;
      continue;
    }
    const changes = diffRow(found, row, moderation, options.trusted);
    if (stub) Object.assign(changes, { source, sourceId: row.sourceId });
    if (Object.keys(changes).length > 0) counts.updated += 1;
    else counts.unchanged += 1;
    ops.push({
      updateOne: { filter: { _id: found._id }, update: { $set: { ...changes, lastSeenAt: now } } },
    });
  }

  if (ops.length > 0) await model.bulkWrite<Record<string, unknown>>(ops, { ordered: false });
  return counts;
}

function toPoint(p: { lng: number; lat: number }) {
  return { type: 'Point' as const, coordinates: [p.lng, p.lat] as [number, number] };
}

function preparePlace(item: PlaceItem): PreparedRow {
  const area = areaForPoint(item.location.lng, item.location.lat);
  const veganLevel = item.type === 'sanctuary' || item.type === 'garden' ? 'full' : item.veganLevel;
  const city = item.city?.trim() || cityForArea(area);
  return {
    sourceId: item.sourceId,
    slugBase: slugify(item.name),
    set: {
      name: item.name,
      type: item.type,
      veganLevel,
      location: toPoint(item.location),
      address: item.address ?? '',
      city,
      postcode: item.postcode,
      area,
      website: item.website,
      phone: item.phone,
      hours: item.hours,
      chain: item.chain ?? false,
      tags: item.tags ?? [],
      description: item.description?.trim() || describePlace({ type: item.type, veganLevel, city }),
      sourceUrl: item.sourceUrl,
    },
    insertOnly: { photoKeys: [], ratingAvg: 0, reviewCount: 0 },
  };
}

interface HostRef {
  _id: Types.ObjectId;
  area?: HomeArea;
}

/**
 * Events name their host; the organization is resolved by slug and created
 * unverified when missing, so an event never dangles and an admin can verify
 * the org later without touching the events.
 */
async function resolveHosts(hostNames: string[], source: string): Promise<Map<string, HostRef>> {
  const bySlug = new Map<string, string>();
  for (const name of hostNames) bySlug.set(slugify(name), name);
  const slugs = Array.from(bySlug.keys());
  const found = await OrganizationModel.find({ slug: { $in: slugs } })
    .select('_id slug area')
    .lean<Array<{ _id: Types.ObjectId; slug: string; area?: HomeArea }>>();
  const hosts = new Map<string, HostRef>(found.map((o) => [o.slug, { _id: o._id, area: o.area }]));

  const missing = slugs.filter((s) => !hosts.has(s));
  if (missing.length > 0) {
    const now = new Date();
    const created = await OrganizationModel.insertMany(
      missing.map((slug) => ({
        name: bySlug.get(slug),
        slug,
        type: 'org',
        verified: false,
        source,
        sourceId: `${HOST_STUB_PREFIX}${slug}`,
        lastSeenAt: now,
      })),
    );
    for (const org of created) hosts.set(org.slug, { _id: org._id, area: org.area ?? undefined });
  }
  return hosts;
}

async function prepareEvents(items: EventItem[], source: string): Promise<PreparedRow[]> {
  const hosts = await resolveHosts(
    items.map((i) => i.hostName),
    source,
  );
  return items.map((item) => {
    const host = hosts.get(slugify(item.hostName)) as HostRef;
    const startsAt = new Date(item.startsAt);
    const endsAt = item.endsAt
      ? new Date(item.endsAt)
      : new Date(startsAt.getTime() + DEFAULT_EVENT_HOURS * 60 * 60 * 1000);
    const location = item.location ? toPoint(item.location) : undefined;
    const area = item.location
      ? areaForPoint(item.location.lng, item.location.lat)
      : (host.area ?? 'other');
    return {
      sourceId: item.sourceId,
      slugBase: slugify(item.title),
      set: {
        title: item.title,
        type: item.type,
        startsAt,
        endsAt,
        location,
        area,
        venueName: item.venueName ?? '',
        address: item.address ?? '',
        detailsAfterRsvp: item.detailsAfterRsvp ?? false,
        hostType: 'organization',
        hostId: host._id,
        hostModel: 'Organization',
        description: item.description ?? '',
        visibility: item.visibility ?? 'public',
        sourceUrl: item.sourceUrl,
      },
      insertOnly: { rsvpCount: 0 },
    };
  });
}

function prepareOrganization(item: OrganizationItem): PreparedRow {
  return {
    sourceId: item.sourceId,
    slugBase: slugify(item.name),
    set: {
      name: item.name,
      type: item.type,
      description: item.description ?? '',
      website: item.website,
      socials: item.socials ? compact(item.socials) : undefined,
      area: item.area,
      sourceUrl: item.sourceUrl,
    },
    insertOnly: { adminUserIds: [] },
  };
}

function prepareMedia(item: MediaItemInput): PreparedRow {
  return {
    sourceId: item.sourceId,
    slugBase: slugify(item.year ? `${item.title} ${item.year}` : item.title),
    set: {
      title: item.title,
      kind: item.kind,
      year: item.year,
      synopsis: item.synopsis ?? '',
      posterKey: item.posterKey,
      watchLinks: item.watchLinks,
      trailerYoutubeId: item.trailerYoutubeId,
      tags: item.tags,
      externalIds: item.externalIds ? compact(item.externalIds) : undefined,
      sourceUrl: item.sourceUrl,
    },
    insertOnly: { featured: false },
  };
}

function prepareGuide(item: GuideItem): PreparedRow {
  return {
    sourceId: item.sourceId,
    slugBase: slugify(item.title),
    set: {
      title: item.title,
      category: item.category,
      summary: item.summary ?? '',
      body: item.body,
      sources: item.sources.map((s) => compact(s)),
      sourceUrl: item.sourceUrl,
    },
    insertOnly: {},
  };
}

interface ValidatedItem {
  index: number;
  item: unknown;
}

function validateOne(resource: IngestResource, raw: unknown): { item: unknown; errors: string[] } {
  const errors = personalDataErrors(resource, raw);
  if (errors.length > 0) return { item: null, errors };
  const result = ITEM_SCHEMAS[resource].safeParse(raw);
  if (result.success) return { item: result.data, errors };
  for (const issue of result.error.issues) {
    errors.push(`${issue.path.join('.') || '(item)'}: ${issue.message}`);
  }
  return { item: null, errors };
}

function validateItems(
  resource: IngestResource,
  rawItems: unknown[],
): { accepted: ValidatedItem[]; rejected: RejectedItem[] } {
  const accepted: ValidatedItem[] = [];
  const rejected: RejectedItem[] = [];
  const seen = new Set<string>();

  rawItems.forEach((raw, index) => {
    const sourceId =
      isPlainObject(raw) && typeof raw.sourceId === 'string' ? raw.sourceId.trim() : null;
    const { item, errors } = validateOne(resource, raw);
    if (errors.length === 0 && sourceId && seen.has(sourceId)) {
      errors.push('sourceId: duplicated within this batch');
    }
    if (errors.length > 0) {
      rejected.push({ index, sourceId, errors });
      return;
    }
    if (sourceId) seen.add(sourceId);
    accepted.push({ index, item });
  });
  return { accepted, rejected };
}

async function prepare(
  resource: IngestResource,
  source: string,
  items: unknown[],
): Promise<PreparedRow[]> {
  switch (resource) {
    case 'places':
      return (items as PlaceItem[]).map(preparePlace);
    case 'events':
      return prepareEvents(items as EventItem[], source);
    case 'organizations':
      return (items as OrganizationItem[]).map(prepareOrganization);
    case 'media':
      return (items as MediaItemInput[]).map(prepareMedia);
    case 'guides':
      return (items as GuideItem[]).map(prepareGuide);
  }
}

const MODELS: Record<IngestResource, Model<unknown>> = {
  places: PlaceModel as unknown as Model<unknown>,
  events: EventModel as unknown as Model<unknown>,
  organizations: OrganizationModel as unknown as Model<unknown>,
  media: MediaItemModel as unknown as Model<unknown>,
  guides: GuideModel as unknown as Model<unknown>,
};

/**
 * Validate, then upsert, one batch from one source. Per-item failures come
 * back in `rejected` with the item's index so a bot can fix and resend;
 * nothing about the items themselves is logged here or upstream.
 */
export async function ingestItems(
  resource: IngestResource,
  source: string,
  rawItems: unknown[],
  options: IngestOptions,
): Promise<IngestResult> {
  const { accepted, rejected } = validateItems(resource, rawItems);
  if (accepted.length === 0) return { inserted: 0, updated: 0, unchanged: 0, rejected };

  const rows = await prepare(
    resource,
    source,
    accepted.map((a) => a.item),
  );
  const counts = await applyUpserts(MODELS[resource], source, rows, MODERATION[resource], {
    ...options,
    adoptStubs: resource === 'organizations',
  });
  return { ...counts, rejected };
}
