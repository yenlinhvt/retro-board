import { expect, test } from 'vitest';
import { createPresence } from './presence';
import { createRateLimiter } from './rate-limit';

test('presence is ref-counted per publicId and scoped per board', () => {
  const p = createPresence();
  p.join('b1', 'ann');
  p.join('b1', 'ann');
  p.join('b2', 'bob');
  expect(p.online('b1')).toEqual(new Set(['ann']));
  p.leave('b1', 'ann');
  expect(p.online('b1')).toEqual(new Set(['ann']));
  p.leave('b1', 'ann');
  p.leave('b1', 'ann');
  expect(p.online('b1')).toEqual(new Set());
  expect(p.online('b2')).toEqual(new Set(['bob']));
});

test('rate limiter allows capacity bursts and refills over time', () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 30, refillPerSec: 3, now: () => t });
  for (let i = 0; i < 30; i++) expect(rl.take()).toBe(true);
  expect(rl.take()).toBe(false);
  t += 1000;
  expect([rl.take(), rl.take(), rl.take(), rl.take()]).toEqual([true, true, true, false]);
  t += 3_600_000;
  for (let i = 0; i < 30; i++) expect(rl.take()).toBe(true);
  expect(rl.take()).toBe(false);
});
