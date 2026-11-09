import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { notes, type Participant } from '../db/schema';
import { closeBoard } from '../boards/board-service';
import { createTestDb, seedBoard, seedParticipant } from '../test/helpers';
import { addNote, deleteNote, editNote, shareNote } from './note-service';

let db: Db;
let b: string;
let ann: Participant;
let bob: Participant;

async function getNote(id: string) {
  const [row] = await db.select().from(notes).where(eq(notes.id, id));
  return row;
}

beforeEach(async () => {
  db = await createTestDb();
  ({ boardId: b } = await seedBoard(db));
  ann = await seedParticipant(db, b, 'Ann');
  bob = await seedParticipant(db, b, 'Bob');
});

test('add trims text and rejects empty / >1000 chars / bad column', async () => {
  const n = await addNote(db, b, ann.id, 2, '  hello  ');
  expect(n).toMatchObject({ text: 'hello', columnIndex: 2, authorId: ann.id, isPublic: false, boardId: b });
  await expect(addNote(db, b, ann.id, 0, '   ')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addNote(db, b, ann.id, 0, 'x'.repeat(1001))).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addNote(db, b, ann.id, 0, 'x'.repeat(1000))).resolves.toBeDefined();
  await expect(addNote(db, b, ann.id, 4, 'a')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addNote(db, b, ann.id, -1, 'a')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(addNote(db, b, ann.id, 1.5, 'a')).rejects.toMatchObject({ code: 'invalid_input' });
});

describe('permissions', () => {
  test('only author can edit or share a public note (non-author gets forbidden)', async () => {
    const n = await addNote(db, b, ann.id, 0, 'hello');
    await shareNote(db, b, ann.id, n.id);
    await expect(editNote(db, b, bob.id, n.id, 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(shareNote(db, b, bob.id, n.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await getNote(n.id))!.text).toBe('hello');
  });

  test('someone else\'s private note is not_found for edit, share and delete', async () => {
    const n = await addNote(db, b, ann.id, 0, 'secret');
    await expect(editNote(db, b, bob.id, n.id, 'x')).rejects.toMatchObject({ code: 'not_found' });
    await expect(shareNote(db, b, bob.id, n.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteNote(db, b, { participantId: bob.id, isAdmin: false }, n.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await getNote(n.id))!.isPublic).toBe(false);
  });

  test('share sets is_public and shared_at; sharing again is a no-op', async () => {
    const n = await addNote(db, b, ann.id, 0, 'hello');
    await shareNote(db, b, ann.id, n.id);
    const first = await getNote(n.id);
    expect(first!.isPublic).toBe(true);
    expect(first!.sharedAt).toBeInstanceOf(Date);
    await shareNote(db, b, ann.id, n.id);
    expect((await getNote(n.id))!.sharedAt).toEqual(first!.sharedAt);
  });

  test('admin can delete public notes but gets not_found for others\' private notes', async () => {
    const priv = await addNote(db, b, ann.id, 0, 'private');
    const pub = await addNote(db, b, ann.id, 0, 'public');
    await shareNote(db, b, ann.id, pub.id);
    const admin = { participantId: bob.id, isAdmin: true };
    await expect(deleteNote(db, b, admin, priv.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await getNote(priv.id)).toBeDefined();
    await deleteNote(db, b, admin, pub.id);
    expect(await getNote(pub.id)).toBeUndefined();
  });

  test('non-admin non-author cannot delete a public note; author can delete own private note', async () => {
    const pub = await addNote(db, b, ann.id, 0, 'public');
    await shareNote(db, b, ann.id, pub.id);
    await expect(deleteNote(db, b, { participantId: bob.id, isAdmin: false }, pub.id)).rejects.toMatchObject({ code: 'forbidden' });
    const priv = await addNote(db, b, ann.id, 0, 'private');
    await deleteNote(db, b, { participantId: ann.id, isAdmin: false }, priv.id);
    expect(await getNote(priv.id)).toBeUndefined();
  });
});

test('author can edit a public note, and edit updates text, trims and bumps updated_at', async () => {
  const n = await addNote(db, b, ann.id, 0, 'hello');
  await shareNote(db, b, ann.id, n.id);
  const before = (await getNote(n.id))!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  await editNote(db, b, ann.id, n.id, '  changed ');
  const after = (await getNote(n.id))!;
  expect(after.text).toBe('changed');
  expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  await expect(editNote(db, b, ann.id, n.id, '')).rejects.toMatchObject({ code: 'invalid_input' });
});

test('all writes reject with board_closed after close', async () => {
  const n = await addNote(db, b, ann.id, 0, 'hello');
  await closeBoard(db, b, new Date());
  await expect(addNote(db, b, ann.id, 0, 'x')).rejects.toMatchObject({ code: 'board_closed' });
  await expect(editNote(db, b, ann.id, n.id, 'x')).rejects.toMatchObject({ code: 'board_closed' });
  await expect(shareNote(db, b, ann.id, n.id)).rejects.toMatchObject({ code: 'board_closed' });
  await expect(deleteNote(db, b, { participantId: ann.id, isAdmin: false }, n.id)).rejects.toMatchObject({ code: 'board_closed' });
});

test('note id from another board is not_found', async () => {
  const { boardId: other } = await seedBoard(db);
  const otherAnn = await seedParticipant(db, other, 'Ann2');
  const n = await addNote(db, other, otherAnn.id, 0, 'elsewhere');
  await shareNote(db, other, otherAnn.id, n.id);
  await expect(editNote(db, b, ann.id, n.id, 'x')).rejects.toMatchObject({ code: 'not_found' });
  await expect(shareNote(db, b, ann.id, n.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(deleteNote(db, b, { participantId: ann.id, isAdmin: true }, n.id)).rejects.toMatchObject({ code: 'not_found' });
});
