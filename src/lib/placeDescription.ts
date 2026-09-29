import type { PlaceType, VeganLevel } from '../models/enums.js';

/**
 * A one-sentence description for a place whose source has none, so a card is
 * never blank: "Fully vegan cafe in Long Beach. Cuisine: thai, vegan."
 */

const TYPE_LABELS: Record<PlaceType, string> = {
  sanctuary: 'animal sanctuary',
  restaurant: 'restaurant',
  cafe: 'cafe',
  grocery: 'grocery',
  shop: 'shop',
  organization: 'organization',
  venue: 'venue',
  garden: 'community garden',
};

export interface DescribePlaceInput {
  type: PlaceType;
  veganLevel: VeganLevel;
  city: string;
  cuisine?: string[];
}

export function describePlace(input: DescribePlaceInput): string {
  const noun = TYPE_LABELS[input.type];
  const where = input.city.trim() ? ` in ${input.city.trim()}` : '';
  let lead: string;
  if (input.type === 'sanctuary' || input.type === 'garden') {
    lead = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}${where}.`;
  } else if (input.veganLevel === 'full') {
    lead = `Fully vegan ${noun}${where}.`;
  } else {
    lead = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} with vegan options${where}.`;
  }
  const cuisine = (input.cuisine ?? []).map((c) => c.trim()).filter(Boolean);
  return cuisine.length > 0 ? `${lead} Cuisine: ${cuisine.join(', ')}.` : lead;
}
