import { Types } from 'mongoose';
import type { Page } from './cursor.js';
import { badRequest } from './errors.js';

/**
 * Keyset pagination for lists that are not ordered by `_id`: the places
 * ranking, upcoming events, verified-first organizations. The cursor is the
 * base64url of the last row's sort values plus its id, so the next page is a
 * plain range filter and, as with `cursor.ts`, there is no page or skip.
 *
 * `_id` is always the final tiebreaker. Give it explicitly as the last field
 * to choose its direction; otherwise it is ascending.
 */

export type SortDirection = 1 | -1;

export interface KeysetField {
  field: string;
  direction: SortDirection;
}

type Scalar = string | number | boolean | Date | null;

interface DecodedCursor {
  values: Scalar[];
  id: Types.ObjectId;
}

function withId(fields: KeysetField[]): KeysetField[] {
  const last = fields[fields.length - 1];
  return last?.field === '_id' ? fields : [...fields, { field: '_id', direction: 1 }];
}

export function keysetSort(fields: KeysetField[]): Record<string, SortDirection> {
  const sort: Record<string, SortDirection> = {};
  for (const f of withId(fields)) sort[f.field] = f.direction;
  return sort;
}

function encodeValue(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value === undefined) return null;
  return value;
}

function decodeValue(value: unknown): Scalar {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'object' && '$date' in value && typeof value.$date === 'string') {
    const date = new Date(value.$date);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw badRequest('invalid_cursor', 'The cursor is not valid.');
}

export function encodeKeysetCursor(
  row: Record<string, unknown> & { _id: Types.ObjectId },
  fields: KeysetField[],
): string {
  const sortFields = withId(fields).slice(0, -1);
  const values = sortFields.map((f) => encodeValue(row[f.field]));
  return Buffer.from(JSON.stringify([...values, row._id.toHexString()]), 'utf8').toString(
    'base64url',
  );
}

export function decodeKeysetCursor(
  cursor: string | undefined,
  fields: KeysetField[],
): DecodedCursor | null {
  if (!cursor) return null;
  const sortFields = withId(fields).slice(0, -1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid_cursor', 'The cursor is not valid.');
  }
  if (!Array.isArray(parsed) || parsed.length !== sortFields.length + 1) {
    throw badRequest('invalid_cursor', 'The cursor is not valid.');
  }
  const hex = parsed[parsed.length - 1];
  if (typeof hex !== 'string' || hex.length !== 24 || !Types.ObjectId.isValid(hex)) {
    throw badRequest('invalid_cursor', 'The cursor is not valid.');
  }
  return { values: parsed.slice(0, -1).map(decodeValue), id: new Types.ObjectId(hex) };
}

/**
 * Filter fragment selecting rows strictly after the cursor in sort order:
 * `(a > A) or (a = A and b > B) or ... or (all equal and _id > id)`.
 */
export function keysetFilter(
  fields: KeysetField[],
  cursor: string | undefined,
): Record<string, unknown> {
  const decoded = decodeKeysetCursor(cursor, fields);
  if (!decoded) return {};
  const all = withId(fields);
  const values: Scalar[] = [...decoded.values, decoded.id as unknown as Scalar];
  const clauses: Record<string, unknown>[] = [];
  all.forEach((f, i) => {
    const clause: Record<string, unknown> = {};
    for (let j = 0; j < i; j++) {
      const prev = all[j] as KeysetField;
      clause[prev.field] = values[j];
    }
    clause[f.field] = { [f.direction === 1 ? '$gt' : '$lt']: values[i] };
    clauses.push(clause);
  });
  return { $or: clauses };
}

/** Split `limit + 1` rows into a page and the cursor that continues it. */
export function keysetPage<T extends Record<string, unknown> & { _id: Types.ObjectId }>(
  rows: T[],
  limit: number,
  fields: KeysetField[],
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeKeysetCursor(last, fields) : null };
}
