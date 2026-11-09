import { describe, expect, test } from 'vitest';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgres://x', PUBLIC_BASE_URL: 'https://retro.example.com', OWNER_SECRET: 'o'.repeat(16), INVITE_CODES: 'alpha, beta ,', SESSION_SECRET: 's'.repeat(32), ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };

describe('loadConfig', () => {
  test('parses invite codes, trims, drops empties; port defaults 3000; atlassian null when unset', () => {
    const c = loadConfig(base);
    expect(c.inviteCodes).toEqual(['alpha', 'beta']);
    expect(c.port).toBe(3000);
    expect(c.atlassian).toBeNull();
    expect(c.encryptionKey.length).toBe(32);
  });
  test('rejects ENCRYPTION_KEY that is not 32 bytes', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
  });
  test('rejects OWNER_SECRET shorter than 16 chars and empty INVITE_CODES', () => {
    expect(() => loadConfig({ ...base, OWNER_SECRET: 'x', INVITE_CODES: '' })).toThrow(/OWNER_SECRET[\s\S]*INVITE_CODES|INVITE_CODES[\s\S]*OWNER_SECRET/);
  });
  test('atlassian enabled when both set', () => {
    const c = loadConfig({ ...base, ATLASSIAN_CLIENT_ID: 'id', ATLASSIAN_CLIENT_SECRET: 'sec', PORT: '8080' });
    expect(c.atlassian).toEqual({ clientId: 'id', clientSecret: 'sec' });
    expect(c.port).toBe(8080);
  });
  test('TRUST_PROXY defaults false, accepts true/false, blank is unset, rejects junk', () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });
});
