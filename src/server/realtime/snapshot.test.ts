import { beforeEach, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { getBoard, setVoteLimit, type Board } from '../boards/board-service';
import { addActionItem } from '../actions/action-item-service';
import { boards, type Participant } from '../db/schema';
import { addNote, shareNote } from '../notes/note-service';
import { addVote } from '../votes/vote-service';
import { createTestDb, seedBoard, seedParticipant } from '../test/helpers';
import { buildSnapshot } from './snapshot';

let db: Db;
let b: string;
let board: Board;
let ann: Participant;
let bob: Participant;
let annPublicNoteId: string;
const opts = { onlinePublicIds: new Set<string>(), confluenceConnected: true, now: 42_000 };

beforeEach(async () => {
  db = await createTestDb();
  ({ boardId: b } = await seedBoard(db));
  ann = await seedParticipant(db, b, 'Ann');
  bob = await seedParticipant(db, b, 'Bob');
  await addNote(db, b, ann.id, 0, 'ann private');
  const pub = await addNote(db, b, ann.id, 1, 'ann public');
  await shareNote(db, b, ann.id, pub.id);
  annPublicNoteId = pub.id;
  board = await getBoard(db, b);
});

test('private notes are visible only to their author', async () => {
  const s1 = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: false }, opts);
  const s2 = await buildSnapshot(db, b, { participantId: bob.id, isAdmin: true }, opts);
  expect(s1.notes.map((n) => n.text)).toEqual(['ann private', 'ann public']);
  expect(s2.notes.map((n) => n.text)).toEqual(['ann public']); // even admin can't see
  expect(s1.notes[0]).toMatchObject({ isMine: true, isPublic: false, authorName: 'Ann', authorPublicId: ann.publicId });
  expect(s2.notes[0]).toMatchObject({ isMine: false, isPublic: true });
});

test('payload contains no secrets', async () => {
  await addActionItem(db, b, ann.id, { text: 'do it', owner: 'Ann', noteId: annPublicNoteId });
  const json = JSON.stringify(await buildSnapshot(db, b, { participantId: ann.id, isAdmin: true }, opts));
  expect(json).not.toContain(ann.clientId);
  expect(json).not.toContain(ann.id);
  expect(json).not.toContain(bob.id);
  expect(json).not.toContain(board.adminTokenHash);
});

test('votes and myVotes and votesRemaining', async () => {
  await setVoteLimit(db, b, 5);
  await addVote(db, b, ann.id, annPublicNoteId);
  await addVote(db, b, ann.id, annPublicNoteId);
  await addVote(db, b, bob.id, annPublicNoteId);
  const sa = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: false }, opts);
  const sb = await buildSnapshot(db, b, { participantId: bob.id, isAdmin: false }, opts);
  const noteA = sa.notes.find((n) => n.id === annPublicNoteId)!;
  const noteB = sb.notes.find((n) => n.id === annPublicNoteId)!;
  expect(noteA).toMatchObject({ votes: 3, myVotes: 2 });
  expect(noteB).toMatchObject({ votes: 3, myVotes: 1 });
  expect(sa.votesRemaining).toBe(3);
  expect(sb.votesRemaining).toBe(4);
  expect(sa.voteLimit).toBe(5);
});

test('export is null for non-admin and not_connected when disconnected', async () => {
  const nonAdmin = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: false }, opts);
  expect(nonAdmin.export).toBeNull();
  expect(nonAdmin.isAdmin).toBe(false);
  const disconnected = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: true }, { ...opts, confluenceConnected: false });
  expect(disconnected.export).toMatchObject({ status: 'not_connected' });
  expect(disconnected.isAdmin).toBe(true);
  await db.update(boards).set({ exportStatus: 'failed', exportError: 'boom', confluenceSpaceId: 's1', confluenceSpaceName: 'Space', confluenceParentId: 'p1', confluenceParentTitle: 'Parent', confluencePageUrl: 'https://x/y' }).where(eq(boards.id, b));
  const connected = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: true }, opts);
  expect(connected.export).toEqual({ status: 'failed', pageUrl: 'https://x/y', error: 'boom', spaceId: 's1', spaceName: 'Space', parentId: 'p1', parentTitle: 'Parent' });
});

test('online flag from onlinePublicIds; isMe flag set', async () => {
  const s = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: false }, { ...opts, onlinePublicIds: new Set([bob.publicId]) });
  expect(s.participants).toEqual([
    { publicId: ann.publicId, name: 'Ann', online: false, isMe: true },
    { publicId: bob.publicId, name: 'Bob', online: true, isMe: false },
  ]);
  expect(s.serverNow).toBe(42_000);
  expect(s.timer).toEqual(board.timer);
});

test('actionItems canEdit is true for creator or admin only', async () => {
  await addActionItem(db, b, ann.id, { text: 'ann item', owner: '', noteId: null });
  const asAnn = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: false }, opts);
  const asBob = await buildSnapshot(db, b, { participantId: bob.id, isAdmin: false }, opts);
  const asAdmin = await buildSnapshot(db, b, { participantId: bob.id, isAdmin: true }, opts);
  expect(asAnn.actionItems.map((a) => a.canEdit)).toEqual([true]);
  expect(asBob.actionItems.map((a) => a.canEdit)).toEqual([false]);
  expect(asAdmin.actionItems.map((a) => a.canEdit)).toEqual([true]);
});
