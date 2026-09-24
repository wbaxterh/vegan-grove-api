import { Types } from 'mongoose';
import { badRequest } from './errors.js';

/**
 * Opaque cursor pagination over `_id`, newest first. The cursor is the
 * base64url of the last item's ObjectId hex, so clients cannot compute offsets
 * and the API never exposes page/skip.
 */

export function encodeCursor(id: Types.ObjectId): string {
  return Buffer.from(id.toHexString(), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Types.ObjectId | null {
  if (!cursor) return null;
  const hex = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!Types.ObjectId.isValid(hex) || hex.length !== 24) {
    throw badRequest('invalid_cursor', 'The cursor is not valid.');
  }
  return new Types.ObjectId(hex);
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Given `limit + 1` rows sorted by `_id` descending, split off the extra row
 * and derive the cursor for the next page.
 */
export function toPage<T extends { _id: Types.ObjectId }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last._id) : null };
}

/** Filter fragment that continues from a cursor (or matches everything). */
export function afterCursor(cursor: string | undefined): Record<string, unknown> {
  const id = decodeCursor(cursor);
  return id ? { _id: { $lt: id } } : {};
}
