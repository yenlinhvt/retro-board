import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useBoard, type BoardSocket } from './useBoard';
import type { BoardSnapshot } from '../../shared/types';

class FakeSocket implements BoardSocket {
  handlers = new Map<string, (...a: any[]) => void>();
  emitted: { event: string; payload: unknown; ack: (a: unknown) => void }[] = [];
  disconnected = false;
  connectCalls = 0;
  connect() {
    this.connectCalls++;
  }
  on(event: string, h: (...a: any[]) => void) {
    this.handlers.set(event, h);
  }
  emit(event: string, payload: unknown, ack: (a: unknown) => void) {
    this.emitted.push({ event, payload, ack });
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }
}

const snap = { id: 'b1', name: 'Sprint' } as unknown as BoardSnapshot;
const auth = { participantId: 'p1', name: 'Ada' };
let socket: FakeSocket;
const factory = vi.fn((_id: string, _auth: unknown, _get: () => any) => (socket = new FakeSocket()));

beforeEach(() => {
  vi.useFakeTimers();
  factory.mockClear();
});
afterEach(() => vi.useRealTimers());

test('does not connect while auth is null', () => {
  const { result } = renderHook(() => useBoard('b1', null, factory));
  expect(factory).not.toHaveBeenCalled();
  expect(result.current.status).toBe('connecting');
});

test('status transitions: connecting -> connected -> reconnecting -> connected', () => {
  vi.setSystemTime(1000);
  const { result } = renderHook(() => useBoard('b1', auth, factory));
  expect(factory).toHaveBeenCalledWith('b1', { participantId: 'p1', name: 'Ada', adminToken: undefined }, expect.any(Function));
  expect(result.current.status).toBe('connecting');
  act(() => socket.fire('board:state', snap));
  expect(result.current.status).toBe('connected');
  expect(result.current.state).toBe(snap);
  expect(result.current.receivedAt).toBe(1000);
  act(() => socket.fire('disconnect'));
  expect(result.current.status).toBe('reconnecting');
  vi.setSystemTime(2000);
  act(() => socket.fire('board:state', snap));
  expect(result.current.status).toBe('connected');
  expect(result.current.receivedAt).toBe(2000);
});

test('connect_error not_found stops reconnecting', () => {
  const { result } = renderHook(() => useBoard('b1', auth, factory));
  act(() => socket.fire('connect_error', new Error('not_found')));
  expect(result.current.status).toBe('not_found');
  expect(socket.disconnected).toBe(true);
});

test('board:deleted sets deleted and a later disconnect does not override it', () => {
  const { result } = renderHook(() => useBoard('b1', auth, factory));
  act(() => socket.fire('board:state', snap));
  act(() => socket.fire('board:deleted'));
  act(() => socket.fire('disconnect'));
  expect(result.current.status).toBe('deleted');
});

test('disconnects on unmount', () => {
  const { unmount } = renderHook(() => useBoard('b1', auth, factory));
  const s = socket;
  unmount();
  expect(s.disconnected).toBe(true);
});

test('emit resolves with the server ack', async () => {
  const { result } = renderHook(() => useBoard('b1', auth, factory));
  let p!: Promise<unknown>;
  act(() => {
    p = result.current.emit('note:delete', { noteId: 'n1' });
  });
  expect(socket.emitted[0]).toMatchObject({ event: 'note:delete', payload: { noteId: 'n1' } });
  socket.emitted[0]!.ack({ ok: true });
  await expect(p).resolves.toEqual({ ok: true });
});

test('emit times out after 10s with an internal error', async () => {
  const { result } = renderHook(() => useBoard('b1', auth, factory));
  let p!: Promise<unknown>;
  act(() => {
    p = result.current.emit('note:delete', { noteId: 'n1' });
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(p).resolves.toEqual({ ok: false, error: 'internal', message: 'Request timed out' });
});

test('server-initiated disconnect triggers socket.connect()', () => {
  const { result } = renderHook(() => useBoard('b1', auth, factory));
  act(() => socket.fire('board:state', snap));
  act(() => socket.fire('disconnect', 'transport close'));
  expect(socket.connectCalls).toBe(0);
  act(() => socket.fire('disconnect', 'io server disconnect'));
  expect(socket.connectCalls).toBe(1);
  expect(result.current.status).toBe('reconnecting');
});

test('no reconnect after board:deleted', () => {
  renderHook(() => useBoard('b1', auth, factory));
  act(() => socket.fire('board:deleted'));
  act(() => socket.fire('disconnect', 'io server disconnect'));
  expect(socket.connectCalls).toBe(0);
});

test('rename updates the auth used on reconnect without recreating the socket', () => {
  const { rerender } = renderHook(({ a }) => useBoard('b1', a, factory), { initialProps: { a: auth } });
  const first = socket;
  const getAuth = factory.mock.calls[0]![2];
  rerender({ a: { ...auth, name: 'Ada L' } });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(first.disconnected).toBe(false);
  expect(getAuth().name).toBe('Ada L');
});
