import { randomBytes } from 'node:crypto';

const MAX_SLUG_LENGTH = 60;

/** Any Mongoose model with a `slug` field satisfies this. */
export interface SlugLookup {
  exists(filter: { slug: string }): Promise<unknown>;
}

/** Lowercase, ASCII-fold, hyphenate. `"Café Gratitude, Venice"` -> `"cafe-gratitude-venice"`. */
export function slugify(input: string): string {
  const folded = input.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/**
 * Find a slug that is not already taken in `model`. Tries the plain slug first,
 * then appends a short random suffix so two "Veggie Grill"s never collide.
 */
export async function uniqueSlug(model: SlugLookup, name: string): Promise<string> {
  const base = slugify(name);
  if (!(await model.exists({ slug: base }))) return base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${randomBytes(3).toString('hex')}`;
    if (!(await model.exists({ slug: candidate }))) return candidate;
  }
  return `${base}-${randomBytes(6).toString('hex')}`;
}
