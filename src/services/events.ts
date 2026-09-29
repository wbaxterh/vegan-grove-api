import type { Page } from '../lib/cursor.js';
import { type KeysetField, keysetFilter, keysetPage, keysetSort } from '../lib/keyset.js';
import type { HomeArea } from '../models/enums.js';
import {
  type Event,
  EventModel,
  EventRsvpModel,
  FriendshipModel,
  GroveMemberModel,
  GroveModel,
  OrganizationModel,
  type Types,
  type UserDoc,
} from '../models/index.js';

/**
 * Events are the app's unit of action. Listing is public but visibility is
 * decided here, per row, before anything leaves: `public` for everyone,
 * `grove` for that grove's members, `friends` for the creator's friends, and
 * whatever the creator made for themselves. `detailsAfterRsvp` hides the
 * address and the point until the viewer has an RSVP row.
 */

type EventRow = Event & { _id: Types.ObjectId };

const UPCOMING: KeysetField[] = [{ field: 'startsAt', direction: 1 }];

export interface EventViewer {
  userId: Types.ObjectId;
  groveIds: Types.ObjectId[];
  friendIds: Types.ObjectId[];
}

export interface ListEventsQuery {
  from?: Date;
  to?: Date;
  area?: HomeArea;
  groveId?: Types.ObjectId;
  type?: Event['type'];
  cursor?: string;
  limit: number;
}

export interface HostSummary {
  type: 'organization' | 'grove';
  id: string;
  name: string;
  slug: string;
  verified?: boolean;
}

/** What the visibility filter needs to know about the caller; null for anonymous. */
export async function viewerFor(user: UserDoc | undefined): Promise<EventViewer | null> {
  if (!user) return null;
  const [memberships, friendships] = await Promise.all([
    GroveMemberModel.find({ userId: user._id }).select('groveId').lean(),
    FriendshipModel.find({ status: 'accepted', $or: [{ userA: user._id }, { userB: user._id }] })
      .select('userA userB')
      .lean(),
  ]);
  return {
    userId: user._id,
    groveIds: memberships.map((m) => m.groveId),
    friendIds: friendships.map((f) => (f.userA.equals(user._id) ? f.userB : f.userA)),
  };
}

export function visibilityFilter(viewer: EventViewer | null): Record<string, unknown> {
  if (!viewer) return { visibility: 'public' };
  return {
    $or: [
      { visibility: 'public' },
      { visibility: 'grove', hostType: 'grove', hostId: { $in: viewer.groveIds } },
      { visibility: 'friends', createdBy: { $in: viewer.friendIds } },
      { createdBy: viewer.userId },
    ],
  };
}

async function hostSummaries(rows: EventRow[]): Promise<Map<string, HostSummary>> {
  const orgIds = rows.filter((r) => r.hostType === 'organization').map((r) => r.hostId);
  const groveIds = rows.filter((r) => r.hostType === 'grove').map((r) => r.hostId);
  const [orgs, groves] = await Promise.all([
    orgIds.length
      ? OrganizationModel.find({ _id: { $in: orgIds } })
          .select('name slug verified')
          .lean()
      : [],
    groveIds.length
      ? GroveModel.find({ _id: { $in: groveIds } })
          .select('name slug')
          .lean()
      : [],
  ]);
  const hosts = new Map<string, HostSummary>();
  for (const o of orgs) {
    hosts.set(o._id.toHexString(), {
      type: 'organization',
      id: o._id.toHexString(),
      name: o.name,
      slug: o.slug,
      verified: o.verified,
    });
  }
  for (const g of groves) {
    hosts.set(g._id.toHexString(), {
      type: 'grove',
      id: g._id.toHexString(),
      name: g.name,
      slug: g.slug,
    });
  }
  return hosts;
}

async function rsvpedEventIds(viewer: EventViewer | null, rows: EventRow[]): Promise<Set<string>> {
  if (!viewer || rows.length === 0) return new Set();
  const rsvps = await EventRsvpModel.find({
    userId: viewer.userId,
    eventId: { $in: rows.map((r) => r._id) },
  })
    .select('eventId')
    .lean();
  return new Set(rsvps.map((r) => r.eventId.toHexString()));
}

/** The public shape. `createdBy`, `adminEdited` and the host's admins never leave the server. */
export function toPublicEvent(e: EventRow, host: HostSummary | null, canSeeDetails: boolean) {
  return {
    id: e._id.toHexString(),
    title: e.title,
    slug: e.slug,
    type: e.type,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    area: e.area,
    venueName: e.venueName,
    address: canSeeDetails ? e.address : null,
    location:
      canSeeDetails && e.location
        ? { lng: e.location.coordinates[0], lat: e.location.coordinates[1] }
        : null,
    detailsAfterRsvp: e.detailsAfterRsvp,
    host,
    description: e.description,
    coverKey: e.coverKey ?? null,
    visibility: e.visibility,
    rsvpCount: e.rsvpCount,
    status: e.status,
    sourceUrl: e.sourceUrl ?? null,
    createdAt: e.createdAt,
  };
}

export type PublicEvent = ReturnType<typeof toPublicEvent>;

async function decorate(rows: EventRow[], viewer: EventViewer | null): Promise<PublicEvent[]> {
  const [hosts, rsvped] = await Promise.all([hostSummaries(rows), rsvpedEventIds(viewer, rows)]);
  return rows.map((row) => {
    const own = viewer !== null && row.createdBy?.equals(viewer.userId) === true;
    const canSee = !row.detailsAfterRsvp || own || rsvped.has(row._id.toHexString());
    return toPublicEvent(row, hosts.get(row.hostId.toHexString()) ?? null, canSee);
  });
}

/**
 * Published events the viewer may see, soonest first. Without `from` the
 * list starts now (events still running count), so the default answer is
 * "what can I go to next".
 */
export async function listVisibleEvents(
  query: ListEventsQuery,
  viewer: EventViewer | null,
): Promise<Page<PublicEvent>> {
  const from = query.from ?? new Date();
  const filter: Record<string, unknown> = {
    status: 'published',
    endsAt: { $gte: from },
    $and: [visibilityFilter(viewer)],
  };
  if (query.to) filter.startsAt = { $lte: query.to };
  if (query.area) filter.area = query.area;
  if (query.type) filter.type = query.type;
  if (query.groveId) Object.assign(filter, { hostType: 'grove', hostId: query.groveId });
  const after = keysetFilter(UPCOMING, query.cursor);
  if (Object.keys(after).length > 0) (filter.$and as unknown[]).push(after);

  const rows = await EventModel.find(filter)
    .sort(keysetSort(UPCOMING))
    .limit(query.limit + 1)
    .lean<EventRow[]>();
  const page = keysetPage(rows, query.limit, UPCOMING);
  return { items: await decorate(page.items, viewer), nextCursor: page.nextCursor };
}

/** One event by slug, with the host, if the viewer may see it. Cancelled events still resolve. */
export async function getVisibleEventBySlug(
  slug: string,
  viewer: EventViewer | null,
): Promise<PublicEvent | null> {
  const row = await EventModel.findOne({
    slug,
    status: { $in: ['published', 'cancelled'] },
    ...visibilityFilter(viewer),
  }).lean<EventRow>();
  if (!row) return null;
  const [item] = await decorate([row], viewer);
  return item ?? null;
}
