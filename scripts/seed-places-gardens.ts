/**
 * Ingest community gardens from OpenStreetMap: `leisure=garden` with
 * `garden:type=community`, plus named `landuse=allotments`, in the Southern
 * California bounding box. They land as type `garden`, fully vegan, source
 * `osm`, and share every rule of the diet:vegan importer.
 *
 *   npm run ingest:places:gardens -- --dry-run   # fetch and print counts
 *   npm run ingest:places:gardens                # POST to /api/ingest/places
 *
 * Trust is determined server-side by TRUSTED_SOURCES; the script does not pass
 * an --approve flag.
 *
 * Gardens are places to act (grow food, meet neighbours, host a potluck), not
 * businesses, so they never carry a chain flag and their tags say which kind
 * of garden they are.
 */

import type { PlaceItem } from '../src/services/ingest.js';
import { isMain, runScript } from './ingest/lib/client.js';
import { type OverpassElement, runImporter, toPlaceItem } from './lib/osm.js';

const query = (bbox: string) =>
  [
    '[out:json][timeout:120];',
    '(',
    `nwr["leisure"="garden"]["garden:type"="community"]["name"](${bbox});`,
    `nwr["landuse"="allotments"]["name"](${bbox});`,
    ');',
    'out center tags;',
  ].join('');

export function mapGarden(el: OverpassElement): PlaceItem | null {
  const tags = el.tags ?? {};
  const kind = tags.landuse === 'allotments' ? 'allotments' : 'community-garden';
  const item = toPlaceItem(el, { type: 'garden', veganLevel: 'full', extraTags: [kind] });
  return item ? { ...item, chain: false } : null;
}

if (isMain(import.meta.url)) {
  runScript(() => runImporter({ name: 'community gardens', query, map: mapGarden }));
}
