import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * A named, ordered shelf on the library home ("Start here", "For skeptics").
 * Membership lives here as an ordered id list, so one title can sit on many
 * shelves and an editor reorders a shelf without touching the titles.
 */
const mediaCollectionSchema = new Schema(
  {
    slug: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 500 },
    order: { type: Number, default: 0 },
    published: { type: Boolean, default: false },
    itemIds: { type: [Schema.Types.ObjectId], ref: 'MediaItem', default: [] },
  },
  { timestamps: true, collection: 'media_collections' },
);

mediaCollectionSchema.index({ slug: 1 }, { unique: true });
mediaCollectionSchema.index({ published: 1, order: 1 });

export type MediaCollection = InferSchemaType<typeof mediaCollectionSchema>;
export type MediaCollectionDoc = HydratedDocument<MediaCollection>;
export const MediaCollectionModel = model('MediaCollection', mediaCollectionSchema);
