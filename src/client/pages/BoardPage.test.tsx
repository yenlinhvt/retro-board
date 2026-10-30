import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BoardSnapshot } from '../../shared/types';

const hook = vi.hoisted(() => ({ useBoard: vi.fn() }));
vi.mock('../lib/useBoard', () => hook);

import { BoardPage } from './BoardPage';

const snap = (o: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  id: 'b1', name: 'Sprint 12', status: 'open', columns: ['A', 'B', 'C', 'D'], voteLimit: 5, votesRemaining: 4,
  notes: [], participants: [
    { publicId: 'p1', name: 'Ada', online: true, isMe: true },
    { publicId: 'p2', name: 'Bob', online: false, isMe: false },
  ],
  actionItems: [], timer: { status: 'idle', durationMs: 0, endsAt: null, remainingMs: 0 },
  isAdmin: false, export: null, serverNow: 0, ...o,
});

const emit = vi.fn();
const mount = (url = '/b/b1') =>
  render(
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/b/:boardId" element={<BoardPage />} /></Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  emit.mockReset().mockResolvedValue({ ok: true });
  hook.useBoard.mockReset().mockReturnValue({ state: null, receivedAt: 0, status: 'connecting', emit });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('BoardPage asks for a name first', () => {
  mount();
  expect(screen.getByLabelText('Your name')).toBeTruthy();
  expect(hook.useBoard).toHaveBeenLastCalledWith('b1', null);
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  expect(localStorage.getItem('retro.name')).toBe('Ada');
  expect(hook.useBoard).toHaveBeenLastCalledWith('b1', expect.objectContaining({ name: 'Ada' }));
});

test('stored name skips the prompt; shows header, votes remaining, presence', () => {
  localStorage.setItem('retro.name', 'Ada');
  hook.useBoard.mockReturnValue({ state: snap(), receivedAt: 0, status: 'connected', emit });
  mount();
  expect(screen.queryByLabelText('Your name')).toBeNull();
  expect(screen.getByText('Sprint 12')).toBeTruthy();
  expect(screen.getByText(/Votes remaining: 4 of 5/)).toBeTruthy();
  expect(screen.getByText('(you)')).toBeTruthy();
  expect(screen.getAllByRole('img', { name: 'online' })).toHaveLength(1);
  expect(screen.getByRole('region', { name: 'Timer' })).toBeTruthy();
});

test('not_found message', () => {
  localStorage.setItem('retro.name', 'Ada');
  hook.useBoard.mockReturnValue({ state: null, receivedAt: 0, status: 'not_found', emit });
  mount();
  expect(screen.getByText("This board doesn't exist or was deleted.")).toBeTruthy();
});

test('closed board shows banner, badge and is read-only', () => {
  localStorage.setItem('retro.name', 'Ada');
  hook.useBoard.mockReturnValue({ state: snap({ status: 'closed' }), receivedAt: 0, status: 'connected', emit });
  mount();
  expect(screen.getByText('This session is closed — the board is read-only.')).toBeTruthy();
  expect(screen.getByText('Closed')).toBeTruthy();
  expect(screen.queryByLabelText(/Add a note/)).toBeNull();
});

test('reconnecting banner', () => {
  localStorage.setItem('retro.name', 'Ada');
  hook.useBoard.mockReturnValue({ state: snap(), receivedAt: 0, status: 'reconnecting', emit });
  mount();
  expect(screen.getByText(/reconnecting/i)).toBeTruthy();
});

test('failed ack shows a toast that auto-dismisses after 4s', async () => {
  localStorage.setItem('retro.name', 'Ada');
  emit.mockResolvedValue({ ok: false, error: 'vote_limit_reached', message: 'No votes left' });
  hook.useBoard.mockReturnValue({ state: snap(), receivedAt: 0, status: 'connected', emit });
  mount();
  vi.useFakeTimers();
  fireEvent.change(screen.getAllByLabelText(/Add a note/)[0]!, { target: { value: 'x' } });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]!);
  });
  expect(emit).toHaveBeenCalledWith('note:add', { columnIndex: 0, text: 'x' });
  expect(screen.getByText('No votes left')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(4000); });
  expect(screen.queryByText('No votes left')).toBeNull();
});

test('admin token is stored, scrubbed from the URL, passed to the socket, and reused', () => {
  localStorage.setItem('retro.name', 'Ada');
  window.history.replaceState(null, '', '/b/b1?admin=SECRET');
  const { unmount } = mount('/b/b1?admin=SECRET');
  expect(sessionStorage.getItem('retro.admin.b1')).toBe('SECRET');
  expect(window.location.search).toBe('');
  expect(window.location.pathname).toBe('/b/b1');
  expect(hook.useBoard).toHaveBeenLastCalledWith('b1', expect.objectContaining({ adminToken: 'SECRET' }));
  unmount();
  mount('/b/b1');
  expect(hook.useBoard).toHaveBeenLastCalledWith('b1', expect.objectContaining({ adminToken: 'SECRET' }));
});

test('rename emits and updates stored name and auth after ack', async () => {
  localStorage.setItem('retro.name', 'Ada');
  hook.useBoard.mockReturnValue({ state: snap(), receivedAt: 0, status: 'connected', emit });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Change name' }));
  fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Ada L' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(emit).toHaveBeenCalledWith('participant:rename', { name: 'Ada L' });
  await waitFor(() => expect(localStorage.getItem('retro.name')).toBe('Ada L'));
  expect(hook.useBoard).toHaveBeenLastCalledWith('b1', expect.objectContaining({ name: 'Ada L' }));
});
