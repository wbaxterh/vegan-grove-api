import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { createDmCipher, dmCipherFromEnv } from '../src/services/crypto/dm.js';

const key = () => randomBytes(32).toString('base64');

describe('DM at-rest encryption', () => {
  it('round-trips text and uses a fresh nonce per message', () => {
    const cipher = createDmCipher({ v1: key() }, 'v1');
    const a = cipher.encrypt('see you at the vigil');
    const b = cipher.encrypt('see you at the vigil');
    expect(a.keyId).toBe('v1');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(cipher.decrypt(a)).toBe('see you at the vigil');
    expect(cipher.decrypt(b)).toBe('see you at the vigil');
  });

  it('rejects tampered ciphertext', () => {
    const cipher = createDmCipher({ v1: key() }, 'v1');
    const msg = cipher.encrypt('hello');
    const bytes = Buffer.from(msg.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt({ ...msg, ciphertext: bytes.toString('base64') })).toThrow(
      AppError,
    );
  });

  it('decrypts old rows after a key rotation and refuses unknown keys', () => {
    const v1 = key();
    const old = createDmCipher({ v1 }, 'v1').encrypt('archived');
    const rotated = createDmCipher({ v1, v2: key() }, 'v2');
    expect(rotated.keyId).toBe('v2');
    expect(rotated.decrypt(old)).toBe('archived');
    expect(() => rotated.decrypt({ ...old, keyId: 'v9' })).toThrow(AppError);
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => createDmCipher({ v1: Buffer.from('short').toString('base64') }, 'v1')).toThrow();
  });

  it('is optional when no key is configured', () => {
    expect(dmCipherFromEnv({ DM_KEY_ID: 'v1' })).toBeNull();
    expect(dmCipherFromEnv({ DM_ENCRYPTION_KEY: key(), DM_KEY_ID: 'v1' })).not.toBeNull();
  });
});
