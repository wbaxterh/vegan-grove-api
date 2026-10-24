import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { objectIdSchema } from '../lib/schemas.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { getValidated, validate } from '../middleware/validate.js';
import { REPORT_TARGETS } from '../models/index.js';
import { fileReport } from '../services/reports.js';

const reportBody = z
  .object({
    targetType: z.enum(REPORT_TARGETS),
    targetId: objectIdSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

/** Moderation reports. The reporter is the session user, never a body field. */
export function reportsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps));

  router.post('/', validate({ body: reportBody }), async (req, res) => {
    const { body } = getValidated<{ body: z.infer<typeof reportBody> }>(req);
    res.status(201).json({ report: await fileReport(currentUser(req)._id, body) });
  });

  return router;
}
