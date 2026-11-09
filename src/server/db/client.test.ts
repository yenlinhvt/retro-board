import { expect, test, vi } from 'vitest';
import { createDb } from './client';

test('an idle pool client error is logged, not thrown', async () => {
  const onError = vi.fn();
  const { pool, close } = createDb('postgres://u:p@127.0.0.1:1/x', onError);
  const err = new Error('terminating connection due to administrator command');
  expect(() => pool.emit('error', err)).not.toThrow();
  expect(onError).toHaveBeenCalledWith('postgres pool error', err);
  await close();
});

test('the default pool error handler writes to console.error', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { pool, close } = createDb('postgres://u:p@127.0.0.1:1/x');
  const err = new Error('boom');
  expect(() => pool.emit('error', err)).not.toThrow();
  expect(spy).toHaveBeenCalledWith('postgres pool error', err);
  spy.mockRestore();
  await close();
});
