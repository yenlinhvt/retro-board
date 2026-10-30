import { beforeEach, expect, test } from 'vitest';
import type { Db } from '../db/client';
import { closeBoard, getBoard } from '../boards/board-service';
import { createTestDb, seedBoard } from '../test/helpers';
import { applyTimer } from './timer-service';

let db: Db;
let b: string;

beforeEach(async () => {
  db = await createTestDb();
  ({ boardId: b } = await seedBoard(db));
});

test('timer persists across reads', async () => {
  await applyTimer(db, b, { type: 'start', durationMs: 60_000 }, 1_000);
  expect((await getBoard(db, b)).timer).toMatchObject({ status: 'running', endsAt: 61_000 });
});

test('returns the new state and applies successive actions', async () => {
  await applyTimer(db, b, { type: 'start', durationMs: 60_000 }, 1_000);
  const paused = await applyTimer(db, b, { type: 'pause' }, 11_000);
  expect(paused).toMatchObject({ status: 'paused', remainingMs: 50_000, endsAt: null });
  expect((await getBoard(db, b)).timer).toEqual(paused);
});

test('rejects on a closed board and leaves the timer unchanged', async () => {
  await closeBoard(db, b, new Date());
  await expect(applyTimer(db, b, { type: 'start', durationMs: 60_000 }, 1_000)).rejects.toMatchObject({ code: 'board_closed' });
  expect((await getBoard(db, b)).timer.status).toBe('idle');
});
