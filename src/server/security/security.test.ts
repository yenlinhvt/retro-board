import { describe, expect, test } from 'vitest';
import { randomId, hashToken, safeEqual, matchesAny } from './tokens';
import { encrypt, decrypt } from './crypto';
import { DomainError } from '../errors';

describe('security', () => {
  test('randomId(16) is 22 url-safe chars and unique', () => {
    const a = randomId(16);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomId(16)).not.toBe(a);
  });
  test('hashToken is sha256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('safeEqual', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
  test('encrypt/decrypt round-trips and detects tampering', () => {
    const key = Buffer.alloc(32, 7);
    const blob = encrypt('secret-token', key);
    expect(decrypt(blob, key)).toBe('secret-token');
    expect(() => decrypt(blob.slice(0, -2) + 'AA', key)).toThrow();
  });
  test('matchesAny', () => {
    expect(matchesAny('beta', ['alpha', 'beta'])).toBe(true);
    expect(matchesAny('bet', ['alpha', 'beta'])).toBe(false);
  });
  test('DomainError carries code', () => {
    const e = new DomainError('forbidden', 'nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('forbidden');
  });
});
