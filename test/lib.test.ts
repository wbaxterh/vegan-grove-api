import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { afterCursor, decodeCursor, encodeCursor, toPage } from '../src/lib/cursor.js';
import { AppError } from '../src/lib/errors.js';
import { slugify, uniqueSlug } from '../src/lib/slug.js';

describe('cursor', () => {
  it('round-trips an ObjectId through an opaque string', () => {
    const id = new Types.ObjectId();
    const cursor = encodeCursor(id);
    expect(cursor).not.toContain(id.toHexString());
    expect(decodeCursor(cursor)?.equals(id)).toBe(true);
    expect(decodeCursor(undefined)).toBeNull();
    expect(afterCursor(undefined)).toEqual({});
    expect(afterCursor(cursor)).toEqual({ _id: { $lt: id } });
  });

  it('rejects cursors that do not decode to an id', () => {
    expect(() => decodeCursor('bm90LWFuLWlk')).toThrow(AppError);
    expect(() => decodeCursor('!!!')).toThrow(AppError);
  });

  it('splits limit+1 rows into a page and a next cursor', () => {
    const rows = [1, 2, 3].map(() => ({ _id: new Types.ObjectId() }));
    const full = toPage(rows, 2);
    expect(full.items).toHaveLength(2);
    expect(full.nextCursor).toBe(encodeCursor(rows[1]?._id as Types.ObjectId));
    const last = toPage(rows.slice(0, 2), 2);
    expect(last.items).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
  });
});

describe('slug', () => {
  it('folds accents, punctuation and case', () => {
    expect(slugify('Café Gratitude, Venice')).toBe('cafe-gratitude-venice');
    expect(slugify('  --Hello   World!! ')).toBe('hello-world');
    expect(slugify('日本')).toBe('item');
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  it('appends a suffix only when the plain slug is taken', async () => {
    const taken = new Set(['veggie-grill']);
    const model = { exists: async ({ slug }: { slug: string }) => (taken.has(slug) ? {} : null) };
    expect(await uniqueSlug(model, 'Veggie Grill')).toMatch(/^veggie-grill-[a-f0-9]{6}$/);
    expect(await uniqueSlug(model, 'Plant Power')).toBe('plant-power');
  });
});
