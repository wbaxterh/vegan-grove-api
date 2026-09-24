import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { IMAGE_CONTENT_TYPES, UPLOAD_PURPOSES } from '../models/index.js';

const presignBody = z
  .object({
    contentType: z.enum(IMAGE_CONTENT_TYPES),
    purpose: z.enum(UPLOAD_PURPOSES),
  })
  .strict();

const videoCreateBody = z.object({ title: z.string().trim().min(1).max(140) }).strict();

// TODO(m2): wire `services/uploads.ts` (presigned S3 PUT, ready) and Bunny Stream
// (tus upload authorization). Clients strip EXIF before either upload.
export function uploadsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.post('/image/presign', validate({ body: presignBody }), notImplemented);
  router.post('/video/create', validate({ body: videoCreateBody }), notImplemented);

  return router;
}
