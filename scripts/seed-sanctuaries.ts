/**
 * Seed curated sanctuaries from scripts/data/sanctuaries.json.
 *
 *   npm run seed:sanctuaries              # upsert by slug as approved
 *   npm run seed:sanctuaries -- --dry-run # print what would be written
 *
 * Curated rows are approved on insert: each entry was checked by hand against
 * the sanctuary's own site before it went into the JSON. Re-running refreshes
 * the descriptive fields and never touches moderation state on existing rows.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/mongoose.js';
import { createLogger } from '../src/lib/logger.js';
import { slugify } from '../src/lib/slug.js';
import { type HomeArea, PlaceModel } from '../src/models/index.js';

interface CuratedSanctuary {
  name: string;
  address: string;
  city: string;
  area: HomeArea;
  lat: number;
  lng: number;
  website: string;
  description: string;
  tags: string[];
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const dryRun = process.argv.includes('--dry-run');
  const env = loadEnv(
    dryRun
      ? { ...process.env, MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://dry-run' }
      : process.env,
  );
  const logger = createLogger({ NODE_ENV: env.NODE_ENV, LOG_LEVEL: 'info' });
  const dataPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'data',
    'sanctuaries.json',
  );
  const rows = JSON.parse(readFileSync(dataPath, 'utf8')) as CuratedSanctuary[];
  logger.info({ count: rows.length, names: rows.map((r) => r.name) }, 'curated sanctuaries');
  if (dryRun) {
    logger.info('dry run: nothing written');
    return;
  }

  await connectDb(env, logger);
  try {
    const ops = rows.map((r) => ({
      updateOne: {
        filter: { slug: slugify(r.name) },
        update: {
          $set: {
            name: r.name,
            type: 'sanctuary' as const,
            veganLevel: 'full' as const,
            location: { type: 'Point' as const, coordinates: [r.lng, r.lat] as [number, number] },
            address: r.address,
            city: r.city,
            area: r.area,
            website: r.website,
            description: r.description,
            tags: r.tags,
          },
          $setOnInsert: {
            slug: slugify(r.name),
            approvalStatus: 'approved' as const,
            source: 'curated' as const,
            photoKeys: [] as string[],
            ratingAvg: 0,
            reviewCount: 0,
          },
        },
        upsert: true,
      },
    }));
    const result = await PlaceModel.bulkWrite(ops, { ordered: false });
    logger.info(
      {
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
        matched: result.matchedCount,
      },
      'sanctuaries seeded',
    );
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
