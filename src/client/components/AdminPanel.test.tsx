import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AdminPanel } from './AdminPanel';
import type { BoardSnapshot } from '../../shared/types';

afterEach(cleanup);

const state = (o: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  id: 'bid', name: 'Sprint 12', status: 'open', columns: ['A', 'B', 'C', 'D'], voteLimit: 5, votesRemaining: 5, notes: [],
  participants: [], actionItems: [], timer: { status: 'idle', durationMs: 300_000, endsAt: null, remainingMs: 300_000 },
  isAdmin: true, export: null, serverNow: 0, ...o,
});
const emit = () => vi.fn().mockResolvedValue({ ok: true });

test('column rename commits on blur only when changed', () => {
  const e = emit();
  render(<AdminPanel state={state()} emit={e} />);
  const input = screen.getByLabelText('Column 2 name');
  fireEvent.blur(input);
  expect(e).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'Improve' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(e).toHaveBeenCalledWith('admin:renameColumn', { columnIndex: 1, name: 'Improve' });
});

test('vote limit emits on blur when changed and in range; invalid reverts', () => {
  const e = emit();
  render(<AdminPanel state={state()} emit={e} />);
  const input = screen.getByLabelText('Vote limit') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '9' } });
  fireEvent.blur(input);
  expect(e).toHaveBeenCalledWith('admin:setVoteLimit', { limit: 9 });
  fireEvent.change(input, { target: { value: '51' } });
  fireEvent.blur(input);
  expect(e).toHaveBeenCalledTimes(1);
  expect(input.value).toBe('5');
});

test('close asks for confirmation; reopen shown when closed', () => {
  const e = emit();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  const { rerender } = render(<AdminPanel state={state()} emit={e} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
  expect(e).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
  expect(e).toHaveBeenCalledWith('admin:close', {});
  rerender(<AdminPanel state={state({ status: 'closed' })} emit={e} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen session' }));
  expect(e).toHaveBeenCalledWith('admin:reopen', {});
  confirm.mockRestore();
});

test('delete requires typing the exact board name; link has no token', () => {
  const e = emit();
  render(<AdminPanel state={state()} emit={e} />);
  const del = screen.getByRole('button', { name: 'Delete board' }) as HTMLButtonElement;
  expect(del.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Confirm board name'), { target: { value: 'sprint 12' } });
  expect(del.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Confirm board name'), { target: { value: 'Sprint 12' } });
  expect(del.disabled).toBe(false);
  fireEvent.click(del);
  expect(e).toHaveBeenCalledWith('admin:delete', {});
  expect((screen.getByLabelText('Participant link') as HTMLInputElement).value).toBe(`${window.location.origin}/b/bid`);
});
