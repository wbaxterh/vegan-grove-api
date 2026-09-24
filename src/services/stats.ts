import {
  EventModel,
  GroveModel,
  GuideModel,
  MediaItemModel,
  PlaceModel,
  UserModel,
} from '../models/index.js';

export interface Stats {
  places: number;
  upcomingEvents: number;
  groves: number;
  guides: number;
  media: number;
  members: number;
  generatedAt: string;
}

async function computeStats(): Promise<Stats> {
  const now = new Date();
  const [places, upcomingEvents, groves, guides, media, members] = await Promise.all([
    PlaceModel.countDocuments({ approvalStatus: 'approved' }),
    EventModel.countDocuments({
      status: 'published',
      visibility: 'public',
      startsAt: { $gte: now },
    }),
    GroveModel.countDocuments({}),
    GuideModel.countDocuments({ status: 'published' }),
    MediaItemModel.countDocuments({ status: 'published' }),
    UserModel.countDocuments({ deletedAt: null }),
  ]);
  return { places, upcomingEvents, groves, guides, media, members, generatedAt: now.toISOString() };
}

/**
 * Public aggregate counters, the only analytics the platform exposes. Cached
 * for `ttlMs`; a failed refresh serves the last good value rather than a 500.
 */
export function createStatsService(ttlMs: number) {
  let cached: Stats | null = null;
  let cachedAt = 0;
  let inflight: Promise<Stats> | null = null;

  return {
    async getStats(): Promise<Stats> {
      const now = Date.now();
      if (cached && now - cachedAt < ttlMs) return cached;
      if (!inflight) {
        inflight = computeStats()
          .then((stats) => {
            cached = stats;
            cachedAt = Date.now();
            return stats;
          })
          .catch((err) => {
            if (cached) return cached;
            throw err;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    reset() {
      cached = null;
      cachedAt = 0;
    },
  };
}

export type StatsService = ReturnType<typeof createStatsService>;
