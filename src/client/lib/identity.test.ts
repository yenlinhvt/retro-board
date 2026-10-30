import { afterEach, expect, test, vi } from 'vitest';
import { getIdentity, setName } from './identity';

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
