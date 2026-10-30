import { afterEach, expect, test, vi } from 'vitest';
import { getIdentity, setName, uuidV4 } from './identity';

afterEach(() => vi.restoreAllMocks());

test('identity persists participantId and survives storage errors', () => {
  const a = getIdentity();
  expect(getIdentity().participantId).toBe(a.participantId);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const b = getIdentity();
  expect(b.participantId).toMatch(/[0-9a-f-]{36}/);
  expect(getIdentity().participantId).toBe(b.participantId);
});

test('setName persists and falls back to memory when storage throws', () => {
  setName('Ada');
  expect(getIdentity().name).toBe('Ada');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  setName('Grace');
  expect(getIdentity().name).toBe('Grace');
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuidV4 uses crypto.randomUUID when available', () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
  expect(uuidV4()).toBe('11111111-1111-4111-8111-111111111111');
});

test('uuidV4 falls back to getRandomValues outside secure contexts', () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const a = uuidV4();
    expect(a).toMatch(UUID_V4);
    expect(uuidV4()).not.toBe(a);
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
  }
});
