/**
 * Seed the library shelves from scripts/data/media-collections.json and mark
 * the curated titles the seed file flags as featured.
 *
 *   npm run seed:media:collections              # upsert shelves by slug, set featured
 *   npm run seed:media:collections -- --dry-run # resolve titles, print counts, write nothing
 *   npm run seed:media:collections -- --prune-duplicates
 *
 * Shelf membership is given by seed title and resolved to the row the media
 * seed created (`source: curated`, `sourceId` = the Wikidata id, else the
 * slugified title), so it survives slug changes. A title the library does not
 * have yet is skipped with a log line and picked up on the next run.
 *
 * `--prune-duplicates` removes second copies of a curated title that an
 * earlier mismatch between the seed scripts created (same title and year,
 * a different sourceId), keeping the row the seed owns.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/mongoose.js';
import { createLogger } from '../src/lib/logger.js';
import {
  MediaCollectionModel,
  MediaItemModel,
  MediaReactionModel,
  SavedMediaModel,
  type Types,
} from '../src/models/index.js';
import { type SeedEntry, toItem } from './ingest/media-seed.js';

interface CollectionSeed {
  slug: string;
  name: string;
  description: string;
  order: number;
  titles: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const readData = <T>(file: string): T =>
  JSON.parse(readFileSync(path.join(here, 'data', file), 'utf8')) as T;

async function pruneDuplicates(
  seedIds: Set<string>,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  const rows = await MediaItemModel.find({ source: 'curated' })
    .select('_id title year sourceId')
    .lean<Array<{ _id: Types.ObjectId; title: string; year?: number; sourceId: string }>>();
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.title.toLowerCase()}|${r.year ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = group.find((r) => seedIds.has(r.sourceId)) ?? group[0];
    for (const r of group) {
      if (!keep || r._id.equals(keep._id)) continue;
      await Promise.all([
        MediaItemModel.deleteOne({ _id: r._id }),
        SavedMediaModel.deleteMany({ mediaId: r._id }),
        MediaReactionModel.deleteMany({ mediaId: r._id }),
        MediaCollectionModel.updateMany({ itemIds: r._id }, { $pull: { itemIds: r._id } }),
      ]);
      removed += 1;
      logger.info({ title: r.title, sourceId: r.sourceId }, 'duplicate removed');
    }
  }
  return removed;
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const dryRun = process.argv.includes('--dry-run');
  const prune = process.argv.includes('--prune-duplicates');
  const env = loadEnv(
    dryRun
      ? { ...process.env, MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://dry-run' }
      : process.env,
  );
  const logger = createLogger({ NODE_ENV: env.NODE_ENV, LOG_LEVEL: 'info' });

  const seed = readData<SeedEntry[]>('media-seed.json');
  const shelves = readData<CollectionSeed[]>('media-collections.json');
  const bySeedTitle = new Map(seed.map((e) => [e.title, toItem(e).sourceId as string]));
  const featured = seed.filter((e) => e.featured).map((e) => bySeedTitle.get(e.title) as string);
  const unknown = shelves.flatMap((s) => s.titles.filter((t) => !bySeedTitle.has(t)));
  if (unknown.length > 0) throw new Error(`titles not in media-seed.json: ${unknown.join(', ')}`);
  logger.info(
    { shelves: shelves.length, featured: featured.length, titles: bySeedTitle.size },
    'media collections',
  );
  if (dryRun) {
    logger.info('dry run: nothing written');
    return;
  }

  await connectDb(env, logger);
  try {
    if (prune)
      logger.info(
        { removed: await pruneDuplicates(new Set(bySeedTitle.values()), logger) },
        'prune',
      );

    const rows = await MediaItemModel.find({
      source: 'curated',
      sourceId: { $in: Array.from(bySeedTitle.values()) },
    })
      .select('_id sourceId')
      .lean<Array<{ _id: Types.ObjectId; sourceId: string }>>();
    const idBySourceId = new Map(rows.map((r) => [r.sourceId, r._id]));

    const featuredIds = featured.map((s) => idBySourceId.get(s)).filter(Boolean);
    const cleared = await MediaItemModel.updateMany(
      { source: 'curated', featured: true, _id: { $nin: featuredIds } },
      { $set: { featured: false } },
    );
    const set = await MediaItemModel.updateMany(
      { _id: { $in: featuredIds } },
      { $set: { featured: true } },
    );
    logger.info({ featured: set.modifiedCount, cleared: cleared.modifiedCount }, 'featured');

    let upserted = 0;
    for (const shelf of shelves) {
      const itemIds: Types.ObjectId[] = [];
      for (const title of shelf.titles) {
        const id = idBySourceId.get(bySeedTitle.get(title) as string);
        if (id) itemIds.push(id);
        else logger.warn({ shelf: shelf.slug, title }, 'title not in the library yet; skipped');
      }
      await MediaCollectionModel.updateOne(
        { slug: shelf.slug },
        {
          $set: {
            name: shelf.name,
            description: shelf.description,
            order: shelf.order,
            published: true,
            itemIds,
          },
          $setOnInsert: { slug: shelf.slug },
        },
        { upsert: true },
      );
      upserted += 1;
      logger.info({ shelf: shelf.slug, items: itemIds.length }, 'shelf');
    }
    logger.info({ upserted }, 'done');
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
