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

test('rejected connection offers a reload', () => {
  localStorage.setItem('retro.name', 'Ada');
  hook.useBoard.mockReturnValue({ state: snap(), receivedAt: 0, status: 'rejected', emit });
  mount();
  expect(screen.getByRole('alert').textContent).toMatch(/could not join this board/i);
  // jsdom cannot stub location.reload (it is unforgeable), so only the control is checked.
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
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

test('Share all my notes confirms, then shares every private note in order and stops on failure', async () => {
  localStorage.setItem('retro.name', 'Ada');
  const mine = (id: string, columnIndex: number, createdAt: string) => ({
    id, columnIndex, text: id, authorPublicId: 'p1', authorName: 'Ada', isPublic: false, isMine: true,
    votes: 0, myVotes: 0, createdAt, sharedAt: null,
  });
  hook.useBoard.mockReturnValue({
    state: snap({ notes: [mine('b', 2, '2026-01-02T00:00:00Z'), mine('a', 0, '2026-01-01T00:00:00Z'), mine('c', 1, '2026-01-03T00:00:00Z')] }),
    receivedAt: 0, status: 'connected', emit,
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
  mount();
  const button = screen.getByRole('button', { name: 'Share all my notes (3)' });
  fireEvent.click(button);
  expect(emit).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(button); });
  expect(emit.mock.calls.map((c) => c[1].noteId)).toEqual(['a', 'b', 'c']);

  emit.mockReset().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'closed', message: 'Board is closed' });
  await act(async () => { fireEvent.click(button); });
  expect(emit).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Board is closed')).toBeTruthy();
  confirm.mockRestore();
});

test('present mode is per viewer: hides private notes, action items and rename; toggles back', () => {
  localStorage.setItem('retro.name', 'Ada');
  const n = (id: string, isPublic: boolean) => ({
    id, columnIndex: 0, text: id, authorPublicId: 'p1', authorName: 'Ada', isPublic, isMine: true,
    votes: 2, myVotes: 0, createdAt: '2026-01-01T00:00:00Z', sharedAt: isPublic ? '2026-01-01T00:00:00Z' : null,
  });
  hook.useBoard.mockReturnValue({ state: snap({ notes: [n('draft', false), n('shared', true)] }), receivedAt: 0, status: 'connected', emit });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Present' }));
  expect(screen.queryByText('draft')).toBeNull();
  expect(screen.getByText('shared')).toBeTruthy();
  expect(screen.getByLabelText('2 votes').textContent).toBe('👍 2');
  expect(screen.queryByRole('button', { name: /Share all/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Change name' })).toBeNull();
  expect(screen.getByText('(you)')).toBeTruthy();
  expect(emit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Exit present mode' }));
  expect(screen.getByText('draft')).toBeTruthy();
});
