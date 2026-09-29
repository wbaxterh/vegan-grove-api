/**
 * Seed community gardens from OpenStreetMap: `leisure=garden` with
 * `garden:type=community`, plus named `landuse=allotments`, in the Southern
 * California bounding box. They land as type `garden`, fully vegan, source
 * `osm`, and share every rule of the diet:vegan importer.
 *
 *   npm run seed:places:gardens -- --dry-run   # fetch and print counts
 *   npm run seed:places:gardens                # upsert as pending
 *   npm run seed:places:gardens -- --approve   # new rows land approved
 *
 * Gardens are places to act (grow food, meet neighbours, host a potluck), not
 * businesses, so they never carry a chain flag and their tags say which kind
 * of garden they are.
 */

import type { PlaceItem } from '../src/services/ingest.js';
import { type OverpassElement, runImporter, SOCAL_BBOX, toPlaceItem } from './lib/osm.js';

const OVERPASS_QUERY = [
  '[out:json][timeout:120];',
  '(',
  `nwr["leisure"="garden"]["garden:type"="community"]["name"](${SOCAL_BBOX});`,
  `nwr["landuse"="allotments"]["name"](${SOCAL_BBOX});`,
  ');',
  'out center tags;',
].join('');

export function mapGarden(el: OverpassElement): PlaceItem | null {
  const tags = el.tags ?? {};
  const kind = tags.landuse === 'allotments' ? 'allotments' : 'community-garden';
  const item = toPlaceItem(el, { type: 'garden', veganLevel: 'full', extraTags: [kind] });
  return item ? { ...item, chain: false } : null;
}

runImporter({ name: 'community gardens', query: OVERPASS_QUERY, map: mapGarden }).catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
