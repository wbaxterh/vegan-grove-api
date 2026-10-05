import { describe, expect, it } from 'vitest';
import curatedGardens from '../scripts/data/gardens-curated.json' with { type: 'json' };
import sanctuaries from '../scripts/data/sanctuaries.json' with { type: 'json' };
import { mapGarden } from '../scripts/seed-places-gardens.js';
import { mapVeganFeature } from '../scripts/seed-places-osm.js';
import { type PlaceItem, placeItemSchema } from '../src/services/ingest.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

interface CuratedEntry {
  name: string;
  type?: string;
  address: string;
  city: string;
  area: string;
  lat: number;
  lng: number;
  website: string;
  phone?: string;
  hours?: string;
  description: string;
  tags: string[];
}

function toCuratedPlaceItem(
  entry: CuratedEntry,
  defaultType: 'sanctuary' | 'garden',
  veganLevel: 'full' | 'options',
): PlaceItem {
  return {
    sourceId: slugify(entry.name),
    name: entry.name.slice(0, 120),
    type: (entry.type ?? defaultType) as PlaceItem['type'],
    veganLevel,
    location: { lng: entry.lng, lat: entry.lat },
    address: entry.address.slice(0, 240) || undefined,
    city: entry.city.slice(0, 80),
    website: entry.website.slice(0, 500) || undefined,
    phone: entry.phone?.slice(0, 40),
    hours: entry.hours?.slice(0, 200),
    description: entry.description.slice(0, 2000),
    tags: ['curated', ...(entry.tags ?? [])].slice(0, 30),
    sourceUrl: entry.website.slice(0, 500) || undefined,
  };
}

describe('curated places mapping', () => {
  it('maps every curated sanctuary to a valid PlaceItem', () => {
    const failures: string[] = [];
    for (const entry of sanctuaries as CuratedEntry[]) {
      const item = toCuratedPlaceItem(entry, 'sanctuary', 'full');
      const result = placeItemSchema.safeParse(item);
      if (!result.success) {
        failures.push(`${entry.name}: ${result.error.issues.map((i) => i.message).join(', ')}`);
      }
    }
    expect(failures).toEqual([]);
    expect(sanctuaries.length).toBeGreaterThan(0);
  });

  it('maps every curated garden to a valid PlaceItem', () => {
    const failures: string[] = [];
    for (const entry of curatedGardens as CuratedEntry[]) {
      const item = toCuratedPlaceItem(entry, 'garden', 'full');
      const result = placeItemSchema.safeParse(item);
      if (!result.success) {
        failures.push(`${entry.name}: ${result.error.issues.map((i) => i.message).join(', ')}`);
      }
    }
    expect(failures).toEqual([]);
    expect(curatedGardens.length).toBeGreaterThan(0);
  });

  it('preserves rich fields from curated entries', () => {
    const entry = sanctuaries[0] as CuratedEntry;
    const item = toCuratedPlaceItem(entry, 'sanctuary', 'full');

    expect(item.name).toBe(entry.name);
    expect(item.type).toBe('sanctuary');
    expect(item.veganLevel).toBe('full');
    expect(item.location).toEqual({ lng: entry.lng, lat: entry.lat });
    expect(item.address).toBe(entry.address);
    expect(item.city).toBe(entry.city);
    expect(item.website).toBe(entry.website);
    expect(item.description).toBe(entry.description);
    expect(item.tags).toContain('curated');
    expect(item.sourceUrl).toBe(entry.website);
  });

  it('curated items do not include a photoKeys field', () => {
    const entry = sanctuaries[0] as CuratedEntry;
    const item = toCuratedPlaceItem(entry, 'sanctuary', 'full') as Record<string, unknown>;
    expect(item).not.toHaveProperty('photoKeys');
  });
});

describe('OSM places mapping', () => {
  it('maps a restaurant with vegan options to a valid PlaceItem', () => {
    const element = {
      type: 'node' as const,
      id: 12345,
      lat: 34.0522,
      lon: -118.2437,
      tags: {
        name: 'Vegan Spot LA',
        amenity: 'restaurant',
        'diet:vegan': 'yes',
        cuisine: 'vegan;thai',
        website: 'https://veganspotla.example.com',
        phone: '+1-555-1234',
        opening_hours: 'Mo-Su 11:00-21:00',
        'addr:street': 'Main St',
        'addr:housenumber': '123',
        'addr:city': 'Los Angeles',
        wheelchair: 'yes',
      },
    };
    const item = mapVeganFeature(element);
    expect(item).toMatchObject({
      sourceId: 'node/12345',
      type: 'restaurant',
      veganLevel: 'options',
      name: 'Vegan Spot LA',
      location: { lng: -118.2437, lat: 34.0522 },
      website: 'https://veganspotla.example.com/',
      phone: '+1-555-1234',
      hours: 'Mo-Su 11:00-21:00',
      address: '123 Main St',
      city: 'Los Angeles',
      sourceUrl: 'https://www.openstreetmap.org/node/12345',
    });
    expect(item?.tags).toContain('vegan');
    expect(item?.tags).toContain('thai');
    expect(item?.tags).toContain('wheelchair');
    expect(placeItemSchema.safeParse(item).success).toBe(true);
  });

  it('maps a fully vegan fast food place', () => {
    const element = {
      type: 'node' as const,
      id: 99999,
      lat: 34.0,
      lon: -118.0,
      tags: {
        name: 'Pure Vegan Fast Food',
        amenity: 'fast_food',
        'diet:vegan': 'only',
      },
    };
    const item = mapVeganFeature(element);
    expect(item).toMatchObject({
      type: 'restaurant',
      veganLevel: 'full',
    });
    expect(placeItemSchema.safeParse(item).success).toBe(true);
  });

  it('rejects fast food with vegan options (not fully vegan)', () => {
    const element = {
      type: 'node' as const,
      id: 88888,
      lat: 34.0,
      lon: -118.0,
      tags: {
        name: 'Regular Fast Food',
        amenity: 'fast_food',
        'diet:vegan': 'yes',
      },
    };
    const item = mapVeganFeature(element);
    expect(item).toBeNull();
  });
});

describe('OSM garden mapping', () => {
  it('maps a community garden to a valid PlaceItem', () => {
    const element = {
      type: 'way' as const,
      id: 55555,
      center: { lat: 34.1, lon: -118.3 },
      tags: {
        name: 'Sunset Community Garden',
        leisure: 'garden',
        'garden:type': 'community',
        website: 'https://garden.example.com',
      },
    };
    const item = mapGarden(element);
    expect(item).toMatchObject({
      sourceId: 'way/55555',
      type: 'garden',
      veganLevel: 'full',
      chain: false,
    });
    expect(item?.tags).toContain('community-garden');
    expect(placeItemSchema.safeParse(item).success).toBe(true);
  });

  it('maps allotments to a valid PlaceItem', () => {
    const element = {
      type: 'way' as const,
      id: 66666,
      center: { lat: 34.2, lon: -118.4 },
      tags: {
        name: 'City Allotments',
        landuse: 'allotments',
      },
    };
    const item = mapGarden(element);
    expect(item).toMatchObject({
      type: 'garden',
    });
    expect(item?.tags).toContain('allotments');
    expect(placeItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('places ingest does not accept photos', () => {
  it('placeItemSchema rejects photoKeys field', () => {
    const itemWithPhotos = {
      sourceId: 'test-place',
      name: 'Test Place',
      type: 'restaurant',
      veganLevel: 'full',
      location: { lng: -118.0, lat: 34.0 },
      photoKeys: ['image1.jpg', 'image2.jpg'],
    };
    const result = placeItemSchema.safeParse(itemWithPhotos);
    expect(result.success).toBe(false);
  });
});
