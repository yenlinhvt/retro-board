import { expect, test } from 'vitest';
import { insertAt } from './EmojiPicker';

test('insertAt replaces the selection and moves the cursor after the emoji', () => {
  expect(insertAt('ab', '🎉', 1, 1, 10)).toEqual({ text: 'a🎉b', cursor: 3 });
  expect(insertAt('abcd', '👍', 1, 3, 10)).toEqual({ text: 'a👍d', cursor: 3 });
});

test('insertAt leaves the text alone when the emoji would exceed the limit', () => {
  expect(insertAt('abc', '🎉', 3, 3, 4)).toEqual({ text: 'abc', cursor: 3 });
});
