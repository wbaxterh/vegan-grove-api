/**
 * Create the ten regional Groves, one per home area (everything but `other`).
 *
 *   npm run seed:groves              # upsert by slug
 *   npm run seed:groves -- --dry-run # print the list, touch nothing
 *
 * Idempotent: the slug is the area with hyphens, the name and area are
 * refreshed on every run, and the description is written only on insert so
 * an organizer's edit survives a re-run. Member counts are never touched.
 */
import { config as loadDotenv } from 'dotenv';
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/mongoose.js';
import { AREA_LABELS } from '../src/lib/areas.js';
import { createLogger } from '../src/lib/logger.js';
import { GroveModel, HOME_AREAS, type HomeArea } from '../src/models/index.js';

interface RegionalGrove {
  area: Exclude<HomeArea, 'other'>;
  name: string;
  description: string;
}

const DESCRIPTIONS: Record<Exclude<HomeArea, 'other'>, string> = {
  la_westside:
    'Santa Monica to Culver City to West Hollywood: outreach on the promenade, potlucks in Venice.',
  la_eastside:
    'Downtown, Hollywood, Silver Lake, Highland Park and East LA: vigils, cubes and the busiest vegan blocks in the county.',
  south_bay: 'Torrance to San Pedro and the beach cities: pier outreach and sanctuary carpools.',
  long_beach: 'Long Beach, Signal Hill and Lakewood: the harbour city crew.',
  sgv: 'Pasadena to Pomona along the 10 and the 210: the San Gabriel Valley.',
  sfv: 'Burbank to Chatsworth: the San Fernando Valley, closest to the Acton and Santa Clarita sanctuaries.',
  orange_county:
    'Fullerton to San Clemente: Orange County outreach, screenings and sanctuary days.',
  inland_empire: 'Riverside, San Bernardino and the Temecula valley: the Inland Empire.',
  san_diego: 'Oceanside to the border: San Diego County.',
  ventura: 'Ventura, Oxnard, Thousand Oaks and Ojai: Ventura County.',
};

export const REGIONAL_GROVES: RegionalGrove[] = HOME_AREAS.filter(
  (a): a is Exclude<HomeArea, 'other'> => a !== 'other',
).map((area) => ({ area, name: `${AREA_LABELS[area]} Grove`, description: DESCRIPTIONS[area] }));

export const groveSlug = (area: HomeArea) => area.replace(/_/g, '-');

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const dryRun = process.argv.includes('--dry-run');
  const env = loadEnv(
    dryRun
      ? { ...process.env, MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://dry-run' }
      : process.env,
  );
  const logger = createLogger({ NODE_ENV: env.NODE_ENV, LOG_LEVEL: 'info' });
  logger.info(
    { groves: REGIONAL_GROVES.map((g) => `${groveSlug(g.area)}: ${g.name}`) },
    'regional groves',
  );
  if (dryRun) {
    logger.info('dry run: nothing written');
    return;
  }

  await connectDb(env, logger);
  try {
    const result = await GroveModel.bulkWrite(
      REGIONAL_GROVES.map((g) => ({
        updateOne: {
          filter: { slug: groveSlug(g.area) },
          update: {
            $set: { name: g.name, area: g.area },
            $setOnInsert: { slug: groveSlug(g.area), description: g.description, memberCount: 0 },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    logger.info(
      {
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
        matched: result.matchedCount,
      },
      'groves seeded',
    );
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
