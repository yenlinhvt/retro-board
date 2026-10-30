import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_COLUMNS } from '../../shared/constants';
import type { Db } from '../db/client';
import { hashToken } from '../security/tokens';
import { createTestDb, seedBoard } from '../test/helpers';
import {
  assertOpen, closeBoard, createBoard, deleteBoard, getBoard, renameColumn, reopenBoard, setVoteLimit, verifyAdmin,
} from './board-service';
import { renameParticipant, upsertParticipant } from './participant-service';

let db: Db;
let id: string;
beforeEach(async () => {
  db = await createTestDb();
  ({ boardId: id } = await seedBoard(db));
});

test('createBoard returns admin token whose hash is stored, with 4 default columns', async () => {
  const { board, adminToken } = await createBoard(db, { name: ' Sprint 42 ' });
  expect(board.name).toBe('Sprint 42');
  expect(board.columns).toEqual([...DEFAULT_COLUMNS]);
  expect(board.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(board.adminTokenHash).toBe(hashToken(adminToken));
  expect(board.exportStatus).toBe('idle');
  expect(verifyAdmin(board, adminToken)).toBe(true);
  expect(verifyAdmin(board, 'nope')).toBe(false);
  expect(verifyAdmin(board, undefined)).toBe(false);
});

test('createBoard rejects empty and over-long names', async () => {
  await expect(createBoard(db, { name: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(createBoard(db, { name: 'x'.repeat(101) })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('createBoard copies Confluence defaults', async () => {
  const { board } = await createBoard(db, {
    name: 'B',
    defaults: { spaceId: 's1', spaceName: 'Space', parentId: 'p1', parentTitle: 'Parent' },
  });
  expect(board).toMatchObject({
    confluenceSpaceId: 's1', confluenceSpaceName: 'Space', confluenceParentId: 'p1', confluenceParentTitle: 'Parent',
  });
});

test('getBoard throws not_found', async () => {
  await expect(getBoard(db, 'missing')).rejects.toMatchObject({ code: 'not_found' });
});

test('renameColumn validates index and length', async () => {
  await expect(renameColumn(db, id, 4, 'x')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(renameColumn(db, id, 0, '  ')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(renameColumn(db, id, 0, 'x'.repeat(61))).rejects.toMatchObject({ code: 'invalid_input' });
  await renameColumn(db, id, 2, ' Puzzles ');
  expect((await getBoard(db, id)).columns[2]).toBe('Puzzles');
});

test('setVoteLimit enforces 1..50', async () => {
  await expect(setVoteLimit(db, id, 0)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(setVoteLimit(db, id, 51)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(setVoteLimit(db, id, 1.5)).rejects.toMatchObject({ code: 'invalid_input' });
  await setVoteLimit(db, id, 7);
  expect((await getBoard(db, id)).voteLimit).toBe(7);
});

test('close sets closed_at; reopen clears; delete removes', async () => {
  const now = new Date('2026-01-02T03:04:05Z');
  await closeBoard(db, id, now);
  const closed = await getBoard(db, id);
  expect(closed.status).toBe('closed');
  expect(closed.closedAt).toEqual(now);
  expect(() => assertOpen(closed)).toThrowError(expect.objectContaining({ code: 'board_closed' }));
  await expect(renameColumn(db, id, 0, 'x')).rejects.toMatchObject({ code: 'board_closed' });
  await expect(setVoteLimit(db, id, 3)).rejects.toMatchObject({ code: 'board_closed' });
  await reopenBoard(db, id);
  const reopened = await getBoard(db, id);
  expect(reopened.status).toBe('open');
  expect(reopened.closedAt).toBeNull();
  expect(() => assertOpen(reopened)).not.toThrow();
  await deleteBoard(db, id);
  await expect(getBoard(db, id)).rejects.toMatchObject({ code: 'not_found' });
});

describe('participants', () => {
  test('upsertParticipant is idempotent per clientId and updates name', async () => {
    const a = await upsertParticipant(db, id, 'client-1', 'Ann');
    const b = await upsertParticipant(db, id, 'client-1', ' Annie ');
    expect(b.id).toBe(a.id);
    expect(b.publicId).toBe(a.publicId);
    expect(b.name).toBe('Annie');
    const c = await upsertParticipant(db, id, 'client-2', 'Bob');
    expect(c.id).not.toBe(a.id);
  });

  test('validates names', async () => {
    await expect(upsertParticipant(db, id, 'c', ' ')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(upsertParticipant(db, id, 'c', 'x'.repeat(41))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('renameParticipant updates name', async () => {
    const a = await upsertParticipant(db, id, 'client-1', 'Ann');
    await renameParticipant(db, a.id, ' Zed ');
    expect((await upsertParticipant(db, id, 'client-1', 'Zed')).name).toBe('Zed');
    await expect(renameParticipant(db, a.id, '')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
