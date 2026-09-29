import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { requireIngestPrincipal } from '../middleware/ingestAuth.js';
import { createRateLimiters } from '../middleware/rateLimits.js';
import { getValidated, validate } from '../middleware/validate.js';
import { INGEST_RESOURCES } from '../models/index.js';
import { ingestItems } from '../services/ingest.js';

export const INGEST_MAX_ITEMS = 200;

const params = z.object({ resource: z.enum(INGEST_RESOURCES) });

/** Envelope only. Items are validated one by one so a bad item never fails the batch. */
const body = z
  .object({
    source: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9][a-z0-9:_.-]{0,59}$/i,
        'source must be a short id such as osm or ics:animalplace',
      ),
    items: z.array(z.unknown()).min(1).max(INGEST_MAX_ITEMS),
  })
  .strict();

/**
 * `POST /api/ingest/:resource` (spec section 9). Auth is the ingest key or
 * an admin session; the source decides whether rows land moderated or live.
 * 200 when every item was accepted, 207 when any was rejected; envelope
 * problems are 400 from `validate()`. Logs carry the source and the counts,
 * never an item.
 */
export function ingestRouter(deps: AppDeps): Router {
  const router = Router();
  const limits = createRateLimiters(deps.env);

  router.post(
    '/:resource',
    requireIngestPrincipal(deps),
    limits.ingest,
    validate({ params, body }),
    async (req, res) => {
      const { params: p, body: b } = getValidated<{
        params: z.infer<typeof params>;
        body: z.infer<typeof body>;
      }>(req);
      const trusted = deps.env.TRUSTED_SOURCES.includes(b.source);
      const result = await ingestItems(p.resource, b.source, b.items, { trusted });
      deps.logger.info(
        {
          resource: p.resource,
          source: b.source,
          trusted,
          principal: req.auth ? 'admin' : 'key',
          received: b.items.length,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          rejected: result.rejected.length,
        },
        'ingest',
      );
      res.status(result.rejected.length > 0 ? 207 : 200).json(result);
    },
  );

  return router;
}
