/**
 * Seed `places` from OpenStreetMap features tagged `diet:vegan=yes|only` in
 * the Southern California bounding box.
 *
 *   npm run seed:places:osm -- --dry-run   # fetch and print counts, touch nothing
 *   npm run seed:places:osm                # upsert by osmId as pending
 *
 * Upserts never change `approvalStatus` or `slug` on rows that already exist,
 * so re-running after moderation does not push approved places back to pending.
 */
import { config as loadDotenv } from 'dotenv';
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/mongoose.js';
import { createLogger } from '../src/lib/logger.js';
import { slugify } from '../src/lib/slug.js';
import { type HomeArea, PlaceModel, type PlaceType } from '../src/models/index.js';

const OVERPASS_QUERY =
  '[out:json][timeout:120];nwr["diet:vegan"~"^(yes|only)$"](32.5,-119.5,34.9,-116.0);out center tags;';
const USER_AGENT = 'vegan-grove-seed/0.1 (+https://vegangrove.org)';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface SeedPlace {
  osmId: string;
  name: string;
  type: PlaceType;
  veganLevel: 'full' | 'options';
  location: { type: 'Point'; coordinates: [number, number] };
  address: string;
  city: string;
  area: HomeArea;
  website?: string;
  hours?: string;
  tags: string[];
}

const RESTAURANT_AMENITIES = new Set(['restaurant', 'fast_food', 'food_court']);
const CAFE_AMENITIES = new Set(['cafe', 'ice_cream', 'juice_bar']);
const VENUE_AMENITIES = new Set([
  'bar',
  'pub',
  'nightclub',
  'cinema',
  'theatre',
  'community_centre',
  'events_venue',
]);
const GROCERY_SHOPS = new Set([
  'supermarket',
  'convenience',
  'greengrocer',
  'health_food',
  'deli',
  'bakery',
  'grocery',
  'frozen_food',
  'pastry',
  'confectionery',
  'beverages',
  'tea',
  'coffee',
  'organic',
]);

const CITY_AREAS: Array<[RegExp, HomeArea]> = [
  [/^(long beach|signal hill|lakewood)$/i, 'long_beach'],
  [
    /^(santa monica|venice|culver city|marina del rey|west hollywood|beverly hills|brentwood|playa vista|mar vista)$/i,
    'la_westside',
  ],
  [
    /^(los angeles|glendale|highland park|eagle rock|silver lake|echo park|los feliz|east los angeles)$/i,
    'la_eastside',
  ],
  [
    /^(torrance|redondo beach|hermosa beach|manhattan beach|el segundo|gardena|hawthorne|san pedro|lomita|carson)$/i,
    'south_bay',
  ],
  [
    /^(pasadena|alhambra|arcadia|monrovia|san gabriel|monterey park|south pasadena|rosemead|el monte|covina|west covina|azusa|glendora|claremont|pomona)$/i,
    'sgv',
  ],
  [
    /^(van nuys|sherman oaks|studio city|north hollywood|burbank|encino|tarzana|woodland hills|reseda|northridge|chatsworth|canoga park|granada hills|sylmar)$/i,
    'sfv',
  ],
  [
    /^(irvine|anaheim|santa ana|costa mesa|huntington beach|newport beach|orange|fullerton|tustin|laguna beach|garden grove|fountain valley|mission viejo|lake forest|brea|buena park|seal beach|san clemente)$/i,
    'orange_county',
  ],
  [
    /^(riverside|san bernardino|redlands|ontario|rancho cucamonga|corona|temecula|murrieta|fontana|moreno valley|upland|chino|chino hills|loma linda)$/i,
    'inland_empire',
  ],
  [
    /^(san diego|la jolla|encinitas|oceanside|carlsbad|chula vista|escondido|el cajon|vista|san marcos|del mar|solana beach|la mesa|national city|coronado)$/i,
    'san_diego',
  ],
  [
    /^(ventura|oxnard|thousand oaks|camarillo|simi valley|ojai|moorpark|port hueneme|santa paula|fillmore)$/i,
    'ventura',
  ],
];

function areaForCity(city: string): HomeArea {
  for (const [pattern, area] of CITY_AREAS) if (pattern.test(city.trim())) return area;
  return 'other';
}

const AMENITY_TYPES: Array<[Set<string>, PlaceType]> = [
  [RESTAURANT_AMENITIES, 'restaurant'],
  [CAFE_AMENITIES, 'cafe'],
  [VENUE_AMENITIES, 'venue'],
  [new Set(['animal_shelter']), 'sanctuary'],
];

/** Tag-key fallbacks, checked in order when neither amenity nor shop decided it. */
const KEY_TYPES: Array<[string, PlaceType]> = [
  ['office', 'organization'],
  ['club', 'organization'],
  ['leisure', 'venue'],
  ['tourism', 'venue'],
  ['cuisine', 'restaurant'],
];

function placeType(tags: Record<string, string>): PlaceType | null {
  const amenity = tags.amenity;
  const byAmenity = amenity ? AMENITY_TYPES.find(([set]) => set.has(amenity)) : undefined;
  if (byAmenity) return byAmenity[1];
  if (tags.shop) return GROCERY_SHOPS.has(tags.shop) ? 'grocery' : 'shop';
  return KEY_TYPES.find(([key]) => tags[key])?.[1] ?? null;
}

function toSeedPlace(el: OverpassElement): SeedPlace | null {
  const tags = el.tags ?? {};
  const name = tags.name?.trim();
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const type = placeType(tags);
  if (!name || lat === undefined || lon === undefined || !type) return null;

  const city = tags['addr:city']?.trim() ?? '';
  const address = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const cuisine = (tags.cuisine ?? '')
    .split(';')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

  return {
    osmId: `${el.type}/${el.id}`,
    name: name.slice(0, 120),
    type,
    veganLevel: tags['diet:vegan'] === 'only' ? 'full' : 'options',
    location: { type: 'Point', coordinates: [lon, lat] },
    address: address.slice(0, 240),
    city: city.slice(0, 80),
    area: areaForCity(city),
    website: tags.website ?? tags['contact:website'],
    hours: tags.opening_hours?.slice(0, 200),
    tags: Array.from(new Set(['osm', ...cuisine])).slice(0, 20),
  };
}

async function fetchOverpass(url: string): Promise<OverpassElement[]> {
  const res = await fetch(`${url}?data=${encodeURIComponent(OVERPASS_QUERY)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { elements?: OverpassElement[] };
  return body.elements ?? [];
}

function summarize(places: SeedPlace[]) {
  const byType: Record<string, number> = {};
  const byArea: Record<string, number> = {};
  let full = 0;
  for (const p of places) {
    byType[p.type] = (byType[p.type] ?? 0) + 1;
    byArea[p.area] = (byArea[p.area] ?? 0) + 1;
    if (p.veganLevel === 'full') full += 1;
  }
  return { total: places.length, full, options: places.length - full, byType, byArea };
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

  logger.info({ url: env.OVERPASS_URL }, 'fetching diet:vegan features for SoCal');
  const elements = await fetchOverpass(env.OVERPASS_URL);
  const places = elements.map(toSeedPlace).filter((p): p is SeedPlace => p !== null);
  logger.info(
    { fetched: elements.length, skipped: elements.length - places.length, ...summarize(places) },
    'mapped',
  );

  if (dryRun) {
    logger.info('dry run: nothing written');
    return;
  }

  await connectDb(env, logger);
  try {
    const existing = new Set(
      (
        await PlaceModel.find({ osmId: { $in: places.map((p) => p.osmId) } })
          .select('osmId')
          .lean()
      ).map((p) => p.osmId),
    );
    const usedSlugs = new Set((await PlaceModel.find({}).select('slug').lean()).map((p) => p.slug));

    const ops = places.map((p) => {
      let slug = slugify(p.name);
      if (!existing.has(p.osmId)) {
        let n = 2;
        const base = slug;
        while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
        usedSlugs.add(slug);
      }
      return {
        updateOne: {
          filter: { osmId: p.osmId },
          update: {
            $set: {
              name: p.name,
              type: p.type,
              veganLevel: p.veganLevel,
              location: p.location,
              address: p.address,
              city: p.city,
              area: p.area,
              website: p.website,
              hours: p.hours,
              tags: p.tags,
            },
            $setOnInsert: {
              slug,
              approvalStatus: 'pending' as const,
              source: 'osm' as const,
              description: '',
              photoKeys: [] as string[],
              ratingAvg: 0,
              reviewCount: 0,
            },
          },
          upsert: true,
        },
      };
    });

    const result = ops.length > 0 ? await PlaceModel.bulkWrite(ops, { ordered: false }) : null;
    logger.info(
      {
        inserted: result?.upsertedCount ?? 0,
        updated: result?.modifiedCount ?? 0,
        matched: result?.matchedCount ?? 0,
      },
      'seed complete',
    );
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
