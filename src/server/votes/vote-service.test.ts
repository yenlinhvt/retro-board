import { beforeEach, expect, test } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { closeBoard, setVoteLimit } from '../boards/board-service';
import { notes, votes, type Note, type Participant } from '../db/schema';
import { addNote, shareNote } from '../notes/note-service';
import { createTestDb, seedBoard, seedParticipant } from '../test/helpers';
import { addVote, removeVote } from './vote-service';

let db: Db;
let b: string;
let ann: Participant;
let bob: Participant;
let pub: Note;

async function countVotes(participantId: string, noteId?: string): Promise<number> {
  const where = noteId
    ? and(eq(votes.participantId, participantId), eq(votes.noteId, noteId))
    : eq(votes.participantId, participantId);
  const [row] = await db.select({ n: count() }).from(votes).where(where);
  return row!.n;
}

beforeEach(async () => {
  db = await createTestDb();
  ({ boardId: b } = await seedBoard(db));
  ann = await seedParticipant(db, b, 'Ann');
  bob = await seedParticipant(db, b, 'Bob');
  pub = await addNote(db, b, ann.id, 0, 'public note');
  await shareNote(db, b, ann.id, pub.id);
});

test('can stack multiple votes on one note up to the limit', async () => {
  await setVoteLimit(db, b, 3);
  for (let i = 0; i < 3; i++) await addVote(db, b, ann.id, pub.id);
  await expect(addVote(db, b, ann.id, pub.id)).rejects.toMatchObject({ code: 'vote_limit_reached' });
  expect(await countVotes(ann.id)).toBe(3);
  await addVote(db, b, bob.id, pub.id); // limit is per participant
  expect(await countVotes(bob.id)).toBe(1);
});

test('limit counts votes across notes on the board', async () => {
  await setVoteLimit(db, b, 2);
  const other = await addNote(db, b, ann.id, 1, 'other');
  await shareNote(db, b, ann.id, other.id);
  await addVote(db, b, bob.id, pub.id);
  await addVote(db, b, bob.id, other.id);
  await expect(addVote(db, b, bob.id, pub.id)).rejects.toMatchObject({ code: 'vote_limit_reached' });
});

test('cannot vote on a private note (not_found) or a note from another board', async () => {
  const priv = await addNote(db, b, ann.id, 0, 'private');
  await expect(addVote(db, b, bob.id, priv.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(addVote(db, b, ann.id, priv.id)).rejects.toMatchObject({ code: 'not_found' });
  const { boardId: other } = await seedBoard(db);
  await expect(addVote(db, other, bob.id, pub.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(addVote(db, b, bob.id, 'missing')).rejects.toMatchObject({ code: 'not_found' });
});

test('removeVote removes exactly one of my votes and is a no-op when none', async () => {
  await addVote(db, b, ann.id, pub.id);
  await addVote(db, b, ann.id, pub.id);
  await addVote(db, b, bob.id, pub.id);
  await removeVote(db, b, ann.id, pub.id);
  expect(await countVotes(ann.id, pub.id)).toBe(1);
  expect(await countVotes(bob.id, pub.id)).toBe(1);
  await removeVote(db, b, ann.id, pub.id);
  await removeVote(db, b, ann.id, pub.id);
  expect(await countVotes(ann.id, pub.id)).toBe(0);
  expect(await countVotes(bob.id, pub.id)).toBe(1);
});

test('lowering the limit below cast votes keeps existing votes but blocks new ones', async () => {
  await setVoteLimit(db, b, 5);
  for (let i = 0; i < 4; i++) await addVote(db, b, ann.id, pub.id);
  await setVoteLimit(db, b, 2);
  expect(await countVotes(ann.id)).toBe(4);
  await expect(addVote(db, b, ann.id, pub.id)).rejects.toMatchObject({ code: 'vote_limit_reached' });
});

test('deleting a note removes its votes', async () => {
  await addVote(db, b, ann.id, pub.id);
  await db.delete(notes).where(eq(notes.id, pub.id));
  expect(await countVotes(ann.id)).toBe(0);
});

test('concurrent votes never exceed limit', async () => {
  await setVoteLimit(db, b, 5);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => addVote(db, b, ann.id, pub.id)));
  expect(await countVotes(ann.id)).toBe(5);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
  for (const r of results.filter((r) => r.status === 'rejected')) {
    expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'vote_limit_reached' });
  }
});

test('rejects when board closed', async () => {
  await addVote(db, b, ann.id, pub.id);
  await closeBoard(db, b, new Date());
  await expect(addVote(db, b, ann.id, pub.id)).rejects.toMatchObject({ code: 'board_closed' });
  await expect(removeVote(db, b, ann.id, pub.id)).rejects.toMatchObject({ code: 'board_closed' });
  expect(await countVotes(ann.id)).toBe(1);
});
