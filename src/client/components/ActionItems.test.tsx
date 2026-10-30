import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ActionItems, type ActionItemsProps } from './ActionItems';

afterEach(cleanup);

const note = (id: string, text: string, isPublic: boolean) => ({
  id, columnIndex: 0, text, authorPublicId: 'a', authorName: 'Ada', isPublic, isMine: false, votes: 0, myVotes: 0, createdAt: '', sharedAt: null,
});
const props = (o: Partial<ActionItemsProps> = {}): ActionItemsProps => ({
  items: [], notes: [], participants: [{ publicId: 'p', name: 'Ada', online: true, isMe: true }], readOnly: false,
  emit: vi.fn().mockResolvedValue({ ok: true }), ...o,
});

test('adds an item with owner and a linked public note; private notes and long text handled', async () => {
  const long = 'x'.repeat(80);
  const p = props({ notes: [note('n1', long, true), note('n2', 'secret', false)] });
  const { container } = render(<ActionItems {...p} />);
  expect(screen.queryByRole('option', { name: 'secret' })).toBeNull();
  expect(screen.getByRole('option', { name: `${'x'.repeat(60)}…` })).toBeTruthy();
  expect(container.querySelector('datalist option')?.getAttribute('value')).toBe('Ada');
  fireEvent.change(screen.getByLabelText('Action item'), { target: { value: ' Fix CI ' } });
  fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('From note'), { target: { value: 'n1' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add action item' })); });
  expect(p.emit).toHaveBeenCalledWith('action:add', { text: 'Fix CI', owner: 'Ada', noteId: 'n1' });
  expect((screen.getByLabelText('Action item') as HTMLInputElement).value).toBe('');
});

test('edit and delete only when canEdit; hidden when readOnly', async () => {
  const items = [
    { id: 'a', text: 'mine', owner: '', noteId: null, canEdit: true, createdAt: '' },
    { id: 'b', text: 'theirs', owner: 'Bob', noteId: null, canEdit: false, createdAt: '' },
  ];
  const p = props({ items });
  const { rerender } = render(<ActionItems {...p} />);
  expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Edit action text'), { target: { value: 'changed' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(p.emit).toHaveBeenCalledWith('action:edit', { id: 'a', text: 'changed', owner: '' });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(p.emit).toHaveBeenCalledWith('action:delete', { id: 'a' });
  confirm.mockRestore();
  rerender(<ActionItems {...p} readOnly />);
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByLabelText('Action item')).toBeNull();
});
