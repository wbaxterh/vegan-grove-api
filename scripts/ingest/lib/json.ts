/**
 * Readers for untyped API bodies. The event fetchers build every item from
 * named fields read through these, never by spreading a response object, so
 * a field the contract forbids (a contact, an attendee count, an organizer)
 * cannot reach an item even when the source starts sending it.
 */
export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function readObject(v: unknown): JsonObject | null {
  return isObject(v) ? v : null;
}

export function readArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The string at `key`, or `''` when absent or not a string. */
export function readString(obj: JsonObject, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

/** The finite number at `key` (numeric strings accepted), or null. */
export function readNumber(obj: JsonObject, key: string): number | null {
  const v = obj[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A string or integer id as text, or `''`. */
export function readId(obj: JsonObject, key: string): string {
  const v = obj[key];
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return '';
}
