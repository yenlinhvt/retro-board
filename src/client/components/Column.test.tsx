import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Column, type ColumnProps } from './Column';
import type { NoteView } from '../../shared/types';

afterEach(cleanup);

const note = (o: Partial<NoteView> = {}): NoteView => ({
  id: 'n1', columnIndex: 0, text: 'hello', authorPublicId: 'a', authorName: 'Ada', isPublic: false,
  isMine: true, votes: 0, myVotes: 0, createdAt: '2026-01-01T00:00:00Z', sharedAt: null, ...o,
});
const props = (o: Partial<ColumnProps> = {}): ColumnProps => ({
  index: 0, name: 'Went well', notes: [], sort: 'newest', votesRemaining: 3, onSortChange: vi.fn(),
  onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onShare: vi.fn(), onVote: vi.fn(), onUnvote: vi.fn(),
  readOnly: false, isAdmin: false, ...o,
});

test('private notes show Share; public notes show author and votes', () => {
  const p = props({
    notes: [
      note({ id: 'a', text: 'mine private' }),
      note({ id: 'b', text: 'shared one', isPublic: true, isMine: false, authorName: 'Bob', votes: 2 }),
    ],
  });
  render(<Column {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  expect(p.onShare).toHaveBeenCalledWith('a');
  expect(screen.getByText('Bob')).toBeTruthy();
  expect(screen.getByLabelText('2 votes')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(1);
});

test('note text with <b>hi</b> renders literally', () => {
  render(<Column {...props({ notes: [note({ text: '<b>hi</b>', isPublic: true })] })} />);
  expect(screen.getByText('<b>hi</b>')).toBeTruthy();
});

test('vote button disabled when votesRemaining is 0', () => {
  const n = note({ isPublic: true, isMine: false, myVotes: 1 });
  render(<Column {...props({ votesRemaining: 0, notes: [n] })} />);
  expect((screen.getByRole('button', { name: 'Add vote' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Remove vote' }) as HTMLButtonElement).disabled).toBe(false);
});

test('readOnly hides add box and edit controls', () => {
  const n = note({ isPublic: true });
  render(<Column {...props({ readOnly: true, notes: [n] })} />);
  expect(screen.queryByLabelText(/Add a note/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Add vote' }) as HTMLButtonElement).disabled).toBe(true);
});

test('Ctrl+Enter submits and clears; counter shown', () => {
  const p = props();
  render(<Column {...p} />);
  const box = screen.getByLabelText(/Add a note/);
  fireEvent.change(box, { target: { value: ' idea ' } });
  expect(screen.getByText('6/1000')).toBeTruthy();
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  expect(p.onAdd).toHaveBeenCalledWith(0, 'idea');
  expect((box as HTMLTextAreaElement).value).toBe('');
});

test('votes sort orders by votes desc then oldest first', () => {
  const mk = (id: string, votes: number, createdAt: string) =>
    note({ id, text: id, isPublic: true, votes, createdAt });
  render(<Column {...props({ sort: 'votes', notes: [mk('low', 1, '2026-01-03T00:00:00Z'), mk('tieB', 5, '2026-01-02T00:00:00Z'), mk('tieA', 5, '2026-01-01T00:00:00Z')] })} />);
  const texts = screen.getAllByText(/^(low|tieA|tieB)$/).map((e) => e.textContent);
  expect(texts).toEqual(['tieA', 'tieB', 'low']);
});

test('delete asks for confirmation; admin can delete others public notes', () => {
  const p = props({ isAdmin: true, notes: [note({ id: 'x', isPublic: true, isMine: false })] });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<Column {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(p.onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(p.onDelete).toHaveBeenCalledWith('x');
  confirm.mockRestore();
});

test('edit with Save/Cancel', () => {
  const p = props({ notes: [note({ text: 'old' })] });
  render(<Column {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(p.onEdit).toHaveBeenCalledWith('n1', 'new');
});
