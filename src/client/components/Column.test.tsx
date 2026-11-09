import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Column, type ColumnProps } from './Column';
import type { NoteView } from '../../shared/types';

afterEach(cleanup);

const note = (o: Partial<NoteView> = {}): NoteView => ({
  id: 'n1', columnIndex: 0, text: 'hello', authorPublicId: 'a', authorName: 'Ada', isPublic: false,
  isMine: true, votes: 0, myVotes: 0, createdAt: '2026-01-01T00:00:00Z', sharedAt: null, ...o,
});
const props = (o: Partial<ColumnProps> = {}): ColumnProps => ({
  index: 0, name: 'Went well', notes: [], votesRemaining: 3,
  onAdd: vi.fn().mockResolvedValue({ ok: true }), onEdit: vi.fn().mockResolvedValue({ ok: true }), onDelete: vi.fn(), onShare: vi.fn(), onVote: vi.fn(), onUnvote: vi.fn(), onShareAll: vi.fn(),
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

test('Ctrl+Enter submits and clears; counter shown', async () => {
  const p = props();
  render(<Column {...p} />);
  const box = screen.getByLabelText(/Add a note/);
  fireEvent.change(box, { target: { value: ' idea ' } });
  expect(screen.getByText('6/1000')).toBeTruthy();
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  });
  expect(p.onAdd).toHaveBeenCalledWith(0, 'idea');
  expect((box as HTMLTextAreaElement).value).toBe('');
});

test('notes are ordered oldest first; a shared note dates from when it was shared; no sort buttons', () => {
  const notes = [
    note({ id: 'a', text: 'written-first-shared-last', isPublic: true, createdAt: '2026-01-01T00:00:00Z', sharedAt: '2026-01-05T00:00:00Z' }),
    note({ id: 'b', text: 'written-last-shared-first', isPublic: true, createdAt: '2026-01-03T00:00:00Z', sharedAt: '2026-01-04T00:00:00Z' }),
    note({ id: 'c', text: 'no-shared-time', isPublic: true, createdAt: '2026-01-02T00:00:00Z', sharedAt: null }),
  ];
  render(<Column {...props({ notes })} />);
  const texts = screen.getAllByText(/^(written-first-shared-last|written-last-shared-first|no-shared-time)$/).map((e) => e.textContent);
  expect(texts).toEqual(['no-shared-time', 'written-last-shared-first', 'written-first-shared-last']);
  expect(screen.queryByRole('button', { name: 'Newest' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Votes' })).toBeNull();
});

test('present mode hides private notes and controls, and shows 👍 vote counts', () => {
  const p = props({
    presenting: true,
    notes: [note({ id: 'priv', text: 'secret draft' }), note({ id: 'pub', text: 'shared idea', isPublic: true, isMine: true, votes: 3 })],
  });
  render(<Column {...p} />);
  expect(screen.queryByText('secret draft')).toBeNull();
  expect(screen.queryByRole('group', { name: 'Your private notes' })).toBeNull();
  expect(screen.getByText('shared idea')).toBeTruthy();
  expect(screen.getByLabelText('3 votes').textContent).toBe('👍 3');
  expect(screen.queryByRole('button')).toBeNull();
});

test('emoji picker inserts at the cursor of the new-note box', () => {
  render(<Column {...props()} />);
  const box = screen.getByLabelText('Add a note to Went well') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'great sprint' } });
  box.setSelectionRange(5, 5);
  fireEvent.click(screen.getByRole('button', { name: 'Add emoji' }));
  fireEvent.click(screen.getByRole('button', { name: '🎉' }));
  expect(box.value).toBe('great🎉 sprint');
  expect(screen.queryByRole('group', { name: 'Emoji' })).toBeNull();
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

test('edit with Save/Cancel', async () => {
  const p = props({ notes: [note({ text: 'old' })] });
  render(<Column {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'new' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect(p.onEdit).toHaveBeenCalledWith('n1', 'new');
  expect(screen.queryByLabelText('Edit note')).toBeNull();
});

const fail = { ok: false, error: 'board_closed', message: 'closed' };

test('rejected add keeps the typed text', async () => {
  const p = props({ onAdd: vi.fn().mockResolvedValue(fail) });
  render(<Column {...p} />);
  const box = screen.getByLabelText(/Add a note/) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'keep me' } });
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  });
  expect(p.onAdd).toHaveBeenCalled();
  expect(box.value).toBe('keep me');
});

test('rejected edit stays in edit mode with the draft', async () => {
  const p = props({ onEdit: vi.fn().mockResolvedValue(fail), notes: [note({ text: 'old' })] });
  render(<Column {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'new' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect((screen.getByLabelText('Edit note') as HTMLTextAreaElement).value).toBe('new');
});

test("someone else's private notes are never rendered, even for an admin", () => {
  render(<Column {...props({ isAdmin: true, notes: [note({ id: 'z', text: 'secret', isMine: false, isPublic: false })] })} />);
  expect(screen.queryByText('secret')).toBeNull();
});

test('double submit while the add ack is pending only adds once', async () => {
  let resolve!: (a: { ok: true }) => void;
  const onAdd = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));
  render(<Column {...props({ onAdd })} />);
  const box = screen.getByLabelText(/Add a note/);
  fireEvent.change(box, { target: { value: 'once' } });
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(onAdd).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ ok: true }));
  expect((box as HTMLTextAreaElement).value).toBe('');
});

test('double save while the edit ack is pending only edits once', async () => {
  let resolve!: (a: { ok: true }) => void;
  const onEdit = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));
  render(<Column {...props({ onEdit, notes: [note({ text: 'old' })] })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ ok: true }));
});

test('Share all sends my private notes oldest first; shared area comes before private', () => {
  const p = props({
    notes: [
      note({ id: 'old', text: 'old', createdAt: '2026-01-01T00:00:00Z' }),
      note({ id: 'new', text: 'new', createdAt: '2026-01-02T00:00:00Z' }),
      note({ id: 'pub', text: 'pub', isPublic: true, isMine: false }),
    ],
  });
  render(<Column {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Share all (2)' }));
  expect(p.onShareAll).toHaveBeenCalledWith(['old', 'new']);
  const [shared, mine] = screen.getAllByRole('group').filter((g) => g.matches('.column-area'));
  expect(shared!.getAttribute('aria-label')).toBe('Shared');
  expect(mine!.getAttribute('aria-label')).toBe('Your private notes');
});

test('Share all is hidden with no private notes or when read-only', () => {
  render(<Column {...props({ notes: [note({ isPublic: true })] })} />);
  expect(screen.queryByRole('button', { name: /Share all/ })).toBeNull();
  cleanup();
  render(<Column {...props({ readOnly: true, notes: [note()] })} />);
  expect(screen.queryByRole('button', { name: /Share all/ })).toBeNull();
});
