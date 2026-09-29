import type { HomeArea } from '../models/enums.js';

/**
 * Home areas are derived from coordinates, never from a free-text city
 * (spec section 9). One or more lat/lng boxes per area, checked in order; the
 * first box containing the point wins and everything else is `other`.
 *
 * The boxes are deliberately coarse. They follow the freeways locals use to
 * name a region (the 405, the 710, the 605, the Cleveland National Forest)
 * rather than city limits, so a place a block over a boundary lands in the
 * neighbouring area, which is what a person would say anyway.
 */
export interface AreaBox {
  area: HomeArea;
  /** West edge, degrees longitude. Inclusive. */
  w: number;
  /** South edge, degrees latitude. Inclusive. */
  s: number;
  /** East edge, degrees longitude. Exclusive. */
  e: number;
  /** North edge, degrees latitude. Exclusive. */
  n: number;
}

export const AREA_BOXES: readonly AreaBox[] = [
  // Valley first so Burbank stays out of the Eastside box that overlaps it.
  { area: 'sfv', w: -118.68, s: 34.12, e: -118.28, n: 34.33 },
  { area: 'la_westside', w: -118.6, s: 33.94, e: -118.33, n: 34.12 },
  { area: 'la_eastside', w: -118.33, s: 33.92, e: -118.16, n: 34.2 },
  { area: 'sgv', w: -118.16, s: 33.95, e: -117.7, n: 34.25 },
  // South Bay before Long Beach so the harbour strip between them goes west.
  { area: 'south_bay', w: -118.45, s: 33.7, e: -118.21, n: 33.94 },
  { area: 'long_beach', w: -118.25, s: 33.72, e: -118.11, n: 33.92 },
  // Orange County is two boxes: the coastal plain, then the south county
  // canyons below the Cleveland National Forest so Corona stays Inland Empire.
  { area: 'orange_county', w: -118.12, s: 33.38, e: -117.65, n: 33.95 },
  { area: 'orange_county', w: -117.65, s: 33.38, e: -117.55, n: 33.75 },
  { area: 'inland_empire', w: -117.7, s: 33.42, e: -116.6, n: 34.35 },
  { area: 'san_diego', w: -117.6, s: 32.53, e: -116.1, n: 33.45 },
  { area: 'ventura', w: -119.55, s: 34.05, e: -118.68, n: 34.5 },
];

/** The area a point falls in, or `other` for the rest of the world. */
export function areaForPoint(lng: number, lat: number): HomeArea {
  for (const box of AREA_BOXES) {
    if (lng >= box.w && lng < box.e && lat >= box.s && lat < box.n) return box.area;
  }
  return 'other';
}

/** Human labels, also the `city` fallback when a source has no `addr:city`. */
export const AREA_LABELS: Record<HomeArea, string> = {
  la_westside: 'West Los Angeles',
  la_eastside: 'Los Angeles',
  south_bay: 'South Bay',
  long_beach: 'Long Beach',
  sgv: 'San Gabriel Valley',
  sfv: 'San Fernando Valley',
  orange_county: 'Orange County',
  inland_empire: 'Inland Empire',
  san_diego: 'San Diego',
  ventura: 'Ventura County',
  other: 'Southern California',
};

export function cityForArea(area: HomeArea): string {
  return AREA_LABELS[area];
}
