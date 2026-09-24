import { Router } from 'express';
import type { AppDeps } from '../lib/deps.js';
import { createStatsService } from '../services/stats.js';

/** Public aggregate counters, cached for `STATS_CACHE_TTL_MS` (5 min by default). */
export function statsRouter(deps: AppDeps): Router {
  const router = Router();
  const stats = createStatsService(deps.env.STATS_CACHE_TTL_MS);

  router.get('/', async (_req, res) => {
    const body = await stats.getStats();
    res.setHeader(
      'Cache-Control',
      `public, max-age=${Math.floor(deps.env.STATS_CACHE_TTL_MS / 1000)}`,
    );
    res.json(body);
  });

  return router;
}
