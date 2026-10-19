import { afterCursor, type Page, toPage } from '../lib/cursor.js';
import { type KeysetField, keysetFilter, keysetPage, keysetSort } from '../lib/keyset.js';
import { slugify } from '../lib/slug.js';
import { type Creator, CreatorModel, type Types } from '../models/index.js';

type CreatorRow = Creator & { _id: Types.ObjectId };

const PUBLISHED = { status: 'published' } as const;

function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function toPublicCreator(c: CreatorRow) {
  return {
    id: c._id.toHexString(),
    name: c.name,
    slug: c.slug,
    alsoKnownAs: c.alsoKnownAs ?? [],
    kind: c.kind,
    members: c.members ?? [],
    bio: c.bio ?? '',
    topics: c.topics ?? [],
    country: orNull(c.country),
    languages: c.languages ?? [],
    website: orNull(c.website),
    podcast: orNull(c.podcast),
    socials: c.socials ?? {},
    externalIds: c.externalIds ?? {},
    veganSource: c.veganSource ?? null,
    relatedGuideIds: (c.relatedGuideIds ?? []).map((id) => id.toHexString()),
    relatedMediaIds: (c.relatedMediaIds ?? []).map((id) => id.toHexString()),
    createdAt: c.createdAt,
  };
}

export type PublicCreator = ReturnType<typeof toPublicCreator>;

export function toAdminCreator(c: CreatorRow) {
  return {
    ...toPublicCreator(c),
    status: c.status,
    source: c.source,
    sourceId: c.sourceId,
    sourceUrl: orNull(c.sourceUrl),
    reviewedAt: orNull(c.reviewedAt),
    adminEdited: c.adminEdited ?? [],
    updatedAt: c.updatedAt,
  };
}

export type AdminCreator = ReturnType<typeof toAdminCreator>;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchClause(q: string): Record<string, unknown> {
  const re = new RegExp(escapeRegex(q.trim()), 'i');
  return {
    $or: [{ name: re }, { alsoKnownAs: re }, { bio: re }, { topics: re }],
  };
}

const SORT_FIELDS: KeysetField[] = [
  { field: 'name', direction: 1 },
  { field: '_id', direction: 1 },
];

export interface CreatorListQuery {
  topic?: string;
  lang?: string;
  country?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

export async function listCreators(query: CreatorListQuery): Promise<Page<PublicCreator>> {
  const clauses: Record<string, unknown>[] = [PUBLISHED, keysetFilter(SORT_FIELDS, query.cursor)];
  if (query.topic) clauses.push({ topics: query.topic });
  if (query.lang) clauses.push({ languages: query.lang });
  if (query.country) clauses.push({ country: query.country });
  if (query.q) clauses.push(searchClause(query.q));

  const rows = await CreatorModel.find({ $and: clauses })
    .sort(keysetSort(SORT_FIELDS))
    .limit(query.limit + 1)
    .lean<CreatorRow[]>();

  const page = keysetPage(rows, query.limit, SORT_FIELDS);
  return { items: page.items.map(toPublicCreator), nextCursor: page.nextCursor };
}

export interface GetCreatorResult {
  creator: PublicCreator | null;
  retired: boolean;
}

export async function getCreatorBySlug(slug: string): Promise<GetCreatorResult> {
  const row = await CreatorModel.findOne({ slug }).lean<CreatorRow>();
  if (!row) return { creator: null, retired: false };
  if (row.status === 'retired') return { creator: null, retired: true };
  if (row.status !== 'published') return { creator: null, retired: false };
  return { creator: toPublicCreator(row), retired: false };
}

export interface AdminCreatorListQuery {
  status?: Creator['status'];
  q?: string;
  cursor?: string;
  limit: number;
}

export async function adminListCreators(query: AdminCreatorListQuery): Promise<Page<AdminCreator>> {
  const clauses: Record<string, unknown>[] = [afterCursor(query.cursor)];
  if (query.status) clauses.push({ status: query.status });
  if (query.q) clauses.push(searchClause(query.q));

  const rows = await CreatorModel.find({ $and: clauses })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean<CreatorRow[]>();

  const page = toPage(rows, query.limit);
  return { items: page.items.map(toAdminCreator), nextCursor: page.nextCursor };
}

async function freeSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base) || 'creator';
  let slug = root;
  for (let n = 2; await taken(slug); n++) slug = `${root}-${n}`;
  return slug;
}

export interface AdminCreatorInput {
  name: string;
  alsoKnownAs?: string[];
  kind?: Creator['kind'];
  members?: string[];
  bio?: string;
  topics?: string[];
  country?: string;
  languages?: string[];
  website?: string;
  podcast?: string;
  socials?: Record<string, string>;
  externalIds?: { wikidata?: string };
  veganSource?: { url: string; label: string };
  relatedGuideIds?: string[];
  relatedMediaIds?: string[];
  status?: Creator['status'];
  reviewedAt?: Date;
}

export async function adminCreateCreator(input: AdminCreatorInput): Promise<AdminCreator> {
  const slug = await freeSlug(input.name, async (s) =>
    Boolean(await CreatorModel.exists({ slug: s })),
  );
  const row = await CreatorModel.create({
    ...input,
    slug,
    source: 'admin',
    sourceId: slug,
    adminEdited: Object.keys(input),
    lastSeenAt: new Date(),
  });
  return toAdminCreator(row.toObject() as CreatorRow);
}

export async function adminUpdateCreator(
  id: string | Types.ObjectId,
  patch: Record<string, unknown>,
): Promise<AdminCreator | null> {
  const keys = Object.keys(patch);
  const row = await CreatorModel.findOneAndUpdate(
    { _id: id },
    keys.length > 0 ? { $set: patch, $addToSet: { adminEdited: { $each: keys } } } : {},
    { new: true, runValidators: true },
  ).lean<CreatorRow>();
  return row ? toAdminCreator(row) : null;
}

export async function adminDeleteCreator(id: string | Types.ObjectId): Promise<boolean> {
  const res = await CreatorModel.deleteOne({ _id: id });
  return Boolean(res.deletedCount);
}

export interface IvyCreator {
  name: string;
  bio: string;
  topics: string[];
  languages: string[];
  website: string | null;
  socials: Record<string, string>;
}

export async function findCreatorsForIvy(query: {
  topic?: string;
  language?: string;
  q?: string;
  limit?: number;
}): Promise<IvyCreator[]> {
  const clauses: Record<string, unknown>[] = [PUBLISHED];
  if (query.topic) clauses.push({ topics: query.topic });
  if (query.language) clauses.push({ languages: query.language });
  if (query.q) clauses.push(searchClause(query.q));

  const rows = await CreatorModel.find({ $and: clauses })
    .sort({ name: 1 })
    .limit(query.limit ?? 10)
    .lean<CreatorRow[]>();

  return rows.map((c) => ({
    name: c.name,
    bio: c.bio ?? '',
    topics: c.topics ?? [],
    languages: c.languages ?? [],
    website: c.website ?? null,
    socials: c.socials ? compact(c.socials) : {},
  })) as IvyCreator[];
}
