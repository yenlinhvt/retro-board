import { expect, test } from 'vitest';
import { AUTHOR_COLORS, authorColor, makeColorOf } from './authorColor';

test('authorColor is stable for the same participant', () => {
  expect(authorColor('pub-abc')).toBe(authorColor('pub-abc'));
  expect(AUTHOR_COLORS).toContain(authorColor('pub-abc'));
});

test('authorColor spreads participants across the palette', () => {
  const used = new Set(Array.from({ length: 200 }, (_, i) => authorColor(`participant-${i}`)));
  expect(used.size).toBe(AUTHOR_COLORS.length);
});

test('makeColorOf gives the first ten participants distinct colours in join order', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
  const colorOf = makeColorOf(ids);
  expect(new Set(ids.slice(0, 10).map(colorOf)).size).toBe(10);
  expect(colorOf('p0')).toBe(AUTHOR_COLORS[0]);
  expect(colorOf('p10')).toBe(AUTHOR_COLORS[0]);
  expect(colorOf('unknown')).toBe(authorColor('unknown'));
});
