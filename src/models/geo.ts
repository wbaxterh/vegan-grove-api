import { Schema } from 'mongoose';

/** GeoJSON Point sub-schema shared by places and events. `[lng, lat]` order. */
export const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) =>
          v.length === 2 &&
          v.every(Number.isFinite) &&
          Math.abs(v[0] ?? 999) <= 180 &&
          Math.abs(v[1] ?? 999) <= 90,
        message: 'coordinates must be [lng, lat]',
      },
    },
  },
  { _id: false },
);

export interface Point {
  type: 'Point';
  coordinates: [number, number];
}
