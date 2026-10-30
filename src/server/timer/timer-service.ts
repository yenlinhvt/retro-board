import { eq } from 'drizzle-orm';
import { applyTimerAction } from '../../shared/timer';
import type { TimerAction, TimerState } from '../../shared/types';
import { assertOpen, getBoard } from '../boards/board-service';
import type { Db } from '../db/client';
import { boards } from '../db/schema';

/** Applies a timer action to the persisted timer; `now` is server epoch ms. */
export async function applyTimer(db: Db, boardId: string, action: TimerAction, now: number): Promise<TimerState> {
  const board = await getBoard(db, boardId);
  assertOpen(board);
  const timer = applyTimerAction(board.timer, action, now);
  await db.update(boards).set({ timer }).where(eq(boards.id, boardId));
  return timer;
}
