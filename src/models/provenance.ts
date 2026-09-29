import type { Schema } from 'mongoose';

/**
 * Provenance carried by every collection the ingest contract can write
 * (spec section 9). `(source, sourceId)` is the upsert key for ingested rows;
 * `adminEdited` names the fields an admin changed by hand so a re-ingest
 * never overwrites them; `lastSeenAt` is bumped on every touch.
 */
export function provenanceFields(defaultSource: string) {
  return {
    source: { type: String, required: true as const, default: defaultSource, maxlength: 60 },
    sourceId: { type: String, maxlength: 200 },
    sourceUrl: { type: String, maxlength: 500 },
    lastSeenAt: { type: Date },
    adminEdited: { type: [String], default: [] as string[] },
  };
}

/** Unique per source, only where a `sourceId` exists (member-created rows have none). */
export function provenanceIndex(schema: Schema): void {
  schema.index(
    { source: 1, sourceId: 1 },
    { unique: true, partialFilterExpression: { sourceId: { $type: 'string' } } },
  );
}
