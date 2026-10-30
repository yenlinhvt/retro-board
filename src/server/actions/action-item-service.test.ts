import { beforeEach, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { closeBoard } from '../boards/board-service';
import { actionItems, notes, type Note, type Participant } from '../db/schema';
import { addNote, shareNote } from '../notes/note-service';
import { createTestDb, seedBoard, seedParticipant } from '../test/helpers';
import { addActionItem, deleteActionItem, editActionItem } from './action-item-service';

let db: Db;
let b: string;
let ann: Participant;
let bob: Participant;
let pub: Note;
const annActor = () => ({ participantId: ann.id, isAdmin: false });
const bobActor = () => ({ participantId: bob.id, isAdmin: false });
const adminActor = () => ({ participantId: bob.id, isAdmin: true });

async function getItem(id: string) {
  const [row] = await db.select().from(actionItems).where(eq(actionItems.id, id));
  return row;
}

beforeEach(async () => {
  db = await createTestDb();
  ({ boardId: b } = await seedBoard(db));
  ann = await seedParticipant(db, b, 'Ann');
  bob = await seedParticipant(db, b, 'Bob');
  pub = await addNote(db, b, ann.id, 0, 'public note');
  await shareNote(db, b, ann.id, pub.id);
});

test('add trims and validates lengths (text 1-500, owner 0-60)', async () => {
  const item = await addActionItem(db, b, ann.id, { text: '  Fix CI ', owner: ' Bob ', noteId: null });
  expect(item).toMatchObject({ text: 'Fix CI', owner: 'Bob', noteId: null, createdBy: ann.id, boardId: b });
  await expect(addActionItem(db, b, ann.id, { text: '  ', owner: '', noteId: null })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addActionItem(db, b, ann.id, { text: 'x'.repeat(501), owner: '', noteId: null })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addActionItem(db, b, ann.id, { text: 'x'.repeat(500), owner: 'o'.repeat(60), noteId: null })).resolves.toBeDefined();
  await expect(addActionItem(db, b, ann.id, { text: 'a', owner: 'o'.repeat(61), noteId: null })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: null })).resolves.toMatchObject({ owner: '' });
});

test('can link to a public note; private, missing or other-board notes are invalid_input', async () => {
  const linked = await addActionItem(db, b, bob.id, { text: 'a', owner: '', noteId: pub.id });
  expect(linked.noteId).toBe(pub.id);
  const priv = await addNote(db, b, ann.id, 0, 'private');
  await expect(addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: priv.id })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: 'missing' })).rejects.toMatchObject({ code: 'invalid_input' });
  const { boardId: other } = await seedBoard(db);
  const otherAnn = await seedParticipant(db, other, 'Ann2');
  const otherNote = await addNote(db, other, otherAnn.id, 0, 'x');
  await shareNote(db, other, otherAnn.id, otherNote.id);
  await expect(addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: otherNote.id })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('creator can edit and delete; non-creator non-admin gets forbidden', async () => {
  const item = await addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: null });
  await editActionItem(db, b, annActor(), item.id, { text: ' b ', owner: 'Ann' });
  expect(await getItem(item.id)).toMatchObject({ text: 'b', owner: 'Ann' });
  await expect(editActionItem(db, b, annActor(), item.id, { text: '', owner: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(editActionItem(db, b, bobActor(), item.id, { text: 'c', owner: '' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(deleteActionItem(db, b, bobActor(), item.id)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await getItem(item.id)).toMatchObject({ text: 'b' });
  await deleteActionItem(db, b, annActor(), item.id);
  expect(await getItem(item.id)).toBeUndefined();
});

test('admin can edit and delete anyone\'s item', async () => {
  const item = await addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: null });
  await editActionItem(db, b, adminActor(), item.id, { text: 'by admin', owner: 'X' });
  expect(await getItem(item.id)).toMatchObject({ text: 'by admin', owner: 'X' });
  await deleteActionItem(db, b, adminActor(), item.id);
  expect(await getItem(item.id)).toBeUndefined();
});

test('unknown id or id from another board is not_found', async () => {
  const { boardId: other } = await seedBoard(db);
  const otherAnn = await seedParticipant(db, other, 'Ann2');
  const item = await addActionItem(db, other, otherAnn.id, { text: 'a', owner: '', noteId: null });
  await expect(editActionItem(db, b, adminActor(), item.id, { text: 'x', owner: '' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(deleteActionItem(db, b, adminActor(), item.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(deleteActionItem(db, b, adminActor(), 'missing')).rejects.toMatchObject({ code: 'not_found' });
});

test('deleting the linked note sets noteId to null', async () => {
  const item = await addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: pub.id });
  await db.delete(notes).where(eq(notes.id, pub.id));
  expect((await getItem(item.id))!.noteId).toBeNull();
});

test('closed board rejects add, edit and delete', async () => {
  const item = await addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: null });
  await closeBoard(db, b, new Date());
  await expect(addActionItem(db, b, ann.id, { text: 'a', owner: '', noteId: null })).rejects.toMatchObject({ code: 'board_closed' });
  await expect(editActionItem(db, b, annActor(), item.id, { text: 'x', owner: '' })).rejects.toMatchObject({ code: 'board_closed' });
  await expect(deleteActionItem(db, b, annActor(), item.id)).rejects.toMatchObject({ code: 'board_closed' });
});
