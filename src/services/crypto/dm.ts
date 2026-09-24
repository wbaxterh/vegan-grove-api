import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../../lib/errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedMessage {
  /** base64 of ciphertext || GCM auth tag. */
  ciphertext: string;
  /** base64 of the 96-bit nonce, unique per message. */
  iv: string;
  keyId: string;
}

/**
 * At-rest encryption for DM bodies (spec rule 6). One key per `keyId` so a
 * future KMS-backed key can rotate in while old rows still decrypt.
 */
export function createDmCipher(keys: Record<string, string>, activeKeyId: string) {
  const material = new Map<string, Buffer>();
  for (const [id, base64] of Object.entries(keys)) {
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) throw new Error(`DM key ${id} must be 32 bytes`);
    material.set(id, key);
  }
  if (!material.has(activeKeyId)) throw new Error(`DM key ${activeKeyId} is not loaded`);

  return {
    keyId: activeKeyId,

    encrypt(plaintext: string): EncryptedMessage {
      const key = material.get(activeKeyId) as Buffer;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: Buffer.concat([body, tag]).toString('base64'),
        iv: iv.toString('base64'),
        keyId: activeKeyId,
      };
    },

    decrypt(message: EncryptedMessage): string {
      const key = material.get(message.keyId);
      if (!key) throw new AppError(500, 'dm_key_missing', 'Message key is not available.');
      const packed = Buffer.from(message.ciphertext, 'base64');
      if (packed.length < TAG_BYTES) {
        throw new AppError(500, 'dm_corrupt', 'Message could not be decrypted.');
      }
      const body = packed.subarray(0, packed.length - TAG_BYTES);
      const tag = packed.subarray(packed.length - TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(message.iv, 'base64'));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        throw new AppError(500, 'dm_corrupt', 'Message could not be decrypted.');
      }
    },
  };
}

export type DmCipher = ReturnType<typeof createDmCipher>;

/** Build the cipher from env, or null when no key is configured (dev without DMs). */
export function dmCipherFromEnv(env: {
  DM_ENCRYPTION_KEY?: string;
  DM_KEY_ID: string;
}): DmCipher | null {
  if (!env.DM_ENCRYPTION_KEY) return null;
  return createDmCipher({ [env.DM_KEY_ID]: env.DM_ENCRYPTION_KEY }, env.DM_KEY_ID);
}
