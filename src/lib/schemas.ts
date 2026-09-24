import { Types } from 'mongoose';
import { z } from 'zod';
import { HANDLE_PATTERN } from '../models/user.js';

/** Reusable zod pieces for route boundaries. */

export const objectIdSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v) && v.length === 24, { message: 'must be an id' })
  .transform((v) => new Types.ObjectId(v));

export const idParams = z.object({ id: objectIdSchema });
export const slugParams = z.object({ slug: z.string().min(1).max(80) });

export const paginationQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'must be a valid email' }))
  .pipe(z.string().max(254));

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().regex(HANDLE_PATTERN, 'handle must be 3-24 characters of a-z, 0-9 or _'));

export const passwordSchema = z.string().min(10, 'at least 10 characters').max(200);

/** `w,s,e,n` in degrees, as the map client sends it. */
export const bboxSchema = z.string().transform((raw, ctx) => {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    ctx.addIssue({ code: 'custom', message: 'bbox must be w,s,e,n' });
    return z.NEVER;
  }
  const [w, s, e, n] = parts as [number, number, number, number];
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
    ctx.addIssue({ code: 'custom', message: 'bbox is out of range' });
    return z.NEVER;
  }
  return [w, s, e, n] as [number, number, number, number];
});

export const pointInput = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
