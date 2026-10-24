/**
 * Ingest `places` from OpenStreetMap in the Southern California bounding box.
 *
 *   npm run ingest:places:osm -- --dry-run   # fetch and print counts, touch nothing
 *   npm run ingest:places:osm                # POST to /api/ingest/places as pending
 *
 * Two Overpass clauses share one tiled fetch, so they use the same mirror
 * fallback and the same stop after consecutive failed tiles. OpenStreetMap
 * data is ODbL: both clauses are source `osm` and link each feature.
 *
 * 1. `diet:vegan=yes|only`. `amenity=fast_food` is skipped unless
 *    `diet:vegan=only`. Bars and pubs are venues. Food courts are restaurants.
 *    `brand` or `brand:wikidata` marks a chain.
 * 2. Named `amenity=marketplace` features that are farmers or produce markets
 *    (`marketplace=farmers` and similar values, or a farmers / produce /
 *    greenmarket / farm-stand name). They land as type `grocery` with the tag
 *    `market:farmers`, vegan level `options` unless `diet:vegan=only`, and
 *    never as a chain. Flea, craft, and antique markets are left out.
 *
 * Trust is determined server-side by TRUSTED_SOURCES; the script does not pass
 * an --approve flag. Set `osm` in TRUSTED_SOURCES on the API to have OSM rows
 * land approved.
 *
 * Area comes from the coordinates. `opening_hours`, `phone`, `website`,
 * `addr:*`, `cuisine`, `wheelchair`, `outdoor_seating`, `takeaway` and
 * `delivery` map to fields and tags. A one-sentence description is generated
 * when OSM has none.
 *
 * The script POSTs to POST /api/ingest/places, so a re-run refreshes every
 * source-owned field, never changes a slug, never moves a moderated row
 * backwards, and never overwrites a field an admin edited.
 */

import type { PlaceType, VeganLevel } from '../src/models/index.js';
import type { PlaceItem } from '../src/services/ingest.js';
import { isMain, runScript } from './ingest/lib/client.js';
import { type OverpassElement, runImporter, toPlaceItem } from './lib/osm.js';

export const FARMERS_MARKET_TAG = 'market:farmers';

export const osmPlacesQuery = (bbox: string) =>
  [
    '[out:json][timeout:120];',
    '(',
    `nwr["diet:vegan"~"^(yes|only)$"](${bbox});`,
    `nwr["amenity"="marketplace"]["name"](${bbox});`,
    ');',
    'out center tags;',
  ].join('');

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

/** `marketplace=*` values that mean a farmers or produce market. */
const PRODUCE_KINDS = new Set([
  'farmers',
  'farmers_market',
  'farmer',
  'produce',
  'agricultural',
  'agriculture',
  'greengrocer',
  'vegetable',
  'vegetables',
  'fruit',
  'fruits',
  'greenmarket',
  'farm',
]);

/** Explicitly not a produce market. A farmers/produce name can still rescue one. */
const OTHER_KINDS = new Set([
  'flea',
  'flea_market',
  'craft',
  'crafts',
  'clothes',
  'clothing',
  'christmas',
  'antique',
  'antiques',
  'night',
  'art',
  'fish',
  'livestock',
  'wholesale',
  'specialist',
]);

function marketplaceKinds(tags: Record<string, string>): string[] {
  return (tags.marketplace ?? tags['marketplace:type'] ?? '')
    .split(/[;,]/)
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_'),
    )
    .filter(Boolean);
}

function produceName(name: string): boolean {
  const normalized = name
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ');
  return /\b(?:farmers?'?|farmers?'s|produce)\s+markets?\b|\bgreen\s*markets?\b|\bfarm\s+stands?\b/.test(
    normalized,
  );
}

/**
 * A named marketplace that sells farmers' or produce goods. Other marketplaces
 * (flea, craft, antique) are not places to shop for food.
 */
export function isFarmersMarket(tags: Record<string, string>): boolean {
  if (tags.amenity !== 'marketplace') return false;
  if (!tags.name?.trim()) return false;
  const kinds = marketplaceKinds(tags);
  if (kinds.some((kind) => PRODUCE_KINDS.has(kind))) return true;
  const named = produceName(tags.name);
  if (kinds.some((kind) => OTHER_KINDS.has(kind))) return named;
  return named;
}

function placeType(tags: Record<string, string>): PlaceType | null {
  const amenity = tags.amenity;
  const byAmenity = amenity ? AMENITY_TYPES.find(([set]) => set.has(amenity)) : undefined;
  if (byAmenity) return byAmenity[1];
  if (tags.shop) return GROCERY_SHOPS.has(tags.shop) ? 'grocery' : 'shop';
  return KEY_TYPES.find(([key]) => tags[key])?.[1] ?? null;
}

function farmersMarketLead(veganLevel: VeganLevel, city: string | undefined): string {
  const where = city?.trim() ? ` in ${city.trim()}` : '';
  return veganLevel === 'full' ? `Fully vegan farmers market${where}.` : `Farmers market${where}.`;
}

export function mapVeganFeature(el: OverpassElement): PlaceItem | null {
  const tags = el.tags ?? {};
  const veganLevel = tags['diet:vegan'] === 'only' ? 'full' : 'options';
  if (tags.amenity === 'fast_food' && veganLevel !== 'full') return null;
  const type = placeType(tags);
  if (!type) return null;
  return toPlaceItem(el, { type, veganLevel });
}

/** Grocery plus `market:farmers`. Mixed markets stay `options`; they are not fully vegan. */
export function mapFarmersMarket(el: OverpassElement): PlaceItem | null {
  const tags = el.tags ?? {};
  if (!isFarmersMarket(tags)) return null;
  const veganLevel: VeganLevel = tags['diet:vegan'] === 'only' ? 'full' : 'options';
  const item = toPlaceItem(el, {
    type: 'grocery',
    veganLevel,
    extraTags: [FARMERS_MARKET_TAG],
  });
  if (!item) return null;
  return {
    ...item,
    chain: false,
    description: tags.description?.trim()
      ? item.description
      : farmersMarketLead(veganLevel, item.city),
  };
}

/** Farmers markets first, then the diet:vegan mapping. A cafe named like a market stays a cafe. */
export function mapOsmPlace(el: OverpassElement): PlaceItem | null {
  if (isFarmersMarket(el.tags ?? {})) return mapFarmersMarket(el);
  return mapVeganFeature(el);
}

if (isMain(import.meta.url)) {
  runScript(() =>
    runImporter({
      name: 'diet:vegan places and farmers markets',
      query: osmPlacesQuery,
      map: mapOsmPlace,
    }),
  );
}
