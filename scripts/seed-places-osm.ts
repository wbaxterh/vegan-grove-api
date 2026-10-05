/**
 * Ingest `places` from OpenStreetMap features tagged `diet:vegan=yes|only` in
 * the Southern California bounding box.
 *
 *   npm run ingest:places:osm -- --dry-run   # fetch and print counts, touch nothing
 *   npm run ingest:places:osm                # POST to /api/ingest/places as pending
 *
 * Trust is determined server-side by TRUSTED_SOURCES; the script does not pass
 * an --approve flag. Set `osm` in TRUSTED_SOURCES on the API to have OSM rows
 * land approved.
 *
 * Mapping (spec section 9): `amenity=fast_food` is skipped unless
 * `diet:vegan=only`; `brand` or `brand:wikidata` marks a chain; area comes
 * from the coordinates; `opening_hours`, `phone`, `website`, `addr:*`,
 * `cuisine`, `wheelchair`, `outdoor_seating`, `takeaway` and `delivery` map to
 * fields and tags; a one-sentence description is generated when OSM has none.
 *
 * The script POSTs to POST /api/ingest/places, so a re-run refreshes every
 * source-owned field, never changes a slug, never moves a moderated row
 * backwards, and never overwrites a field an admin edited.
 */

import type { PlaceType } from '../src/models/index.js';
import type { PlaceItem } from '../src/services/ingest.js';
import { isMain, runScript } from './ingest/lib/client.js';
import { type OverpassElement, runImporter, toPlaceItem } from './lib/osm.js';

const query = (bbox: string) =>
  `[out:json][timeout:120];nwr["diet:vegan"~"^(yes|only)$"](${bbox});out center tags;`;

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

function placeType(tags: Record<string, string>): PlaceType | null {
  const amenity = tags.amenity;
  const byAmenity = amenity ? AMENITY_TYPES.find(([set]) => set.has(amenity)) : undefined;
  if (byAmenity) return byAmenity[1];
  if (tags.shop) return GROCERY_SHOPS.has(tags.shop) ? 'grocery' : 'shop';
  return KEY_TYPES.find(([key]) => tags[key])?.[1] ?? null;
}

export function mapVeganFeature(el: OverpassElement): PlaceItem | null {
  const tags = el.tags ?? {};
  const veganLevel = tags['diet:vegan'] === 'only' ? 'full' : 'options';
  if (tags.amenity === 'fast_food' && veganLevel !== 'full') return null;
  const type = placeType(tags);
  if (!type) return null;
  return toPlaceItem(el, { type, veganLevel });
}

if (isMain(import.meta.url)) {
  runScript(() => runImporter({ name: 'diet:vegan places', query, map: mapVeganFeature }));
}
