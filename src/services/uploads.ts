import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';
import { unavailable } from '../lib/errors.js';
import type { IMAGE_CONTENT_TYPES, UPLOAD_PURPOSES } from '../models/enums.js';

const EXTENSIONS: Record<(typeof IMAGE_CONTENT_TYPES)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface PresignInput {
  purpose: (typeof UPLOAD_PURPOSES)[number];
  contentType: (typeof IMAGE_CONTENT_TYPES)[number];
}

/**
 * Presigned PUT so the client uploads straight to S3 and the API never
 * proxies bytes. Keys are random: nothing in the path identifies the member.
 * Credentials come from the default AWS chain (instance role in production).
 */
export function createUploadsService(
  env: Pick<Env, 'AWS_REGION' | 'S3_MEDIA_BUCKET' | 'S3_PRESIGN_TTL_SECONDS'>,
) {
  const client = new S3Client({ region: env.AWS_REGION });

  return {
    async presignImageUpload(input: PresignInput): Promise<{ url: string; key: string }> {
      if (!env.S3_MEDIA_BUCKET) {
        throw unavailable('uploads_unavailable', 'Uploads are not configured.');
      }
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const key = `${input.purpose}/${yyyy}/${mm}/${randomUUID()}.${EXTENSIONS[input.contentType]}`;

      const command = new PutObjectCommand({
        Bucket: env.S3_MEDIA_BUCKET,
        Key: key,
        ContentType: input.contentType,
      });
      const url = await getSignedUrl(client, command, { expiresIn: env.S3_PRESIGN_TTL_SECONDS });
      return { url, key };
    },
  };
}

export type UploadsService = ReturnType<typeof createUploadsService>;
