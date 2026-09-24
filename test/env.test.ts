import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from '../src/config/env.js';

const base = { MONGODB_URI: 'mongodb://localhost:27017/vg' };

describe('loadEnv', () => {
  it('applies defaults and parses lists and numbers', () => {
    const env = loadEnv({ ...base, PORT: '5050', CORS_ORIGINS: 'https://a.test, https://b.test' });
    expect(env.PORT).toBe(5050);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
    expect(env.COMPANION_MODEL).toBe('claude-opus-5');
    expect(env.EMAIL_TRANSPORT).toBe('log');
    expect(env.SESSION_TTL_DAYS).toBe(30);
  });

  it('treats empty values as unset so defaults still apply', () => {
    const env = loadEnv({ ...base, EMAIL_FROM: '', PORT: '' });
    expect(env.PORT).toBe(4000);
    expect(env.EMAIL_FROM).toContain('vegangrove.org');
  });

  it('fails fast on a missing database URI and lists every problem', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(EnvError);
    try {
      loadEnv({ PORT: 'abc' });
    } catch (err) {
      expect((err as Error).message).toContain('MONGODB_URI');
      expect((err as Error).message).toContain('PORT');
    }
  });

  it('requires SMTP settings when the transport is smtp', () => {
    expect(() => loadEnv({ ...base, EMAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_HOST/);
  });

  it('holds production to a higher bar', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      CORS_ORIGINS: 'https://vegangrove.org',
    };
    expect(() => loadEnv(prod)).toThrow(/DM_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...prod, DM_ENCRYPTION_KEY: 'dG9vc2hvcnQ=' })).toThrow(/32 bytes/);
    const ok = loadEnv({ ...prod, DM_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(ok.NODE_ENV).toBe('production');
  });
});
