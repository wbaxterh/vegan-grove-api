import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { notImplemented } from '../lib/errors.js';
import { objectIdSchema } from '../lib/schemas.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { REPORT_TARGETS } from '../models/index.js';

const reportBody = z
  .object({
    targetType: z.enum(REPORT_TARGETS),
    targetId: objectIdSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

// TODO(m2): moderation reports. The reporter is the session user, never a body field.
export function reportsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.post('/', validate({ body: reportBody }), notImplemented);

  return router;
}
