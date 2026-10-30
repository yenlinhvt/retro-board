import { and, eq } from 'drizzle-orm';
import { COLUMN_COUNT, DEFAULT_COLUMNS, LIMITS } from '../../shared/constants';
import type { Db } from '../db/client';
import { boards, type Board } from '../db/schema';
import { DomainError } from '../errors';
import { hashToken, randomId, safeEqual } from '../security/tokens';

export type { Board };

export type ConfluenceDefaults = { spaceId: string; spaceName: string; parentId: string; parentTitle: string };

function boundedText(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new DomainError('invalid_input', `${label} must be 1-${max} characters`);
  }
  return trimmed;
}

export async function createBoard(
  db: Db,
  input: { name: string; defaults?: ConfluenceDefaults | null },
): Promise<{ board: Board; adminToken: string }> {
  const name = boundedText(input.name, LIMITS.boardName, 'Board name');
  const adminToken = randomId(32);
  const d = input.defaults;
  const [board] = await db
    .insert(boards)
    .values({
      id: randomId(16),
      name,
      adminTokenHash: hashToken(adminToken),
      columns: [...DEFAULT_COLUMNS],
      confluenceSpaceId: d?.spaceId ?? null,
      confluenceSpaceName: d?.spaceName ?? null,
      confluenceParentId: d?.parentId ?? null,
      confluenceParentTitle: d?.parentTitle ?? null,
      exportStatus: 'idle',
    })
    .returning();
  return { board: board!, adminToken };
}

export async function getBoard(db: Db, boardId: string): Promise<Board> {
  const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
  if (!board) throw new DomainError('not_found', 'Board not found');
  return board;
}

export function verifyAdmin(board: Board, adminToken: string | undefined): boolean {
  if (!adminToken) return false;
  return safeEqual(hashToken(adminToken), board.adminTokenHash);
}

export function assertOpen(board: Board): void {
  if (board.status !== 'open') throw new DomainError('board_closed', 'Board is closed');
}

export async function renameColumn(db: Db, boardId: string, columnIndex: number, name: string): Promise<void> {
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= COLUMN_COUNT) {
    throw new DomainError('invalid_input', 'Invalid column index');
  }
  const clean = boundedText(name, LIMITS.columnName, 'Column name');
  const board = await getBoard(db, boardId);
  assertOpen(board);
  const columns = [...board.columns];
  columns[columnIndex] = clean;
  await db.update(boards).set({ columns }).where(eq(boards.id, boardId));
}

export async function setVoteLimit(db: Db, boardId: string, limit: number): Promise<void> {
  if (!Number.isInteger(limit) || limit < LIMITS.voteLimitMin || limit > LIMITS.voteLimitMax) {
    throw new DomainError('invalid_input', `Vote limit must be ${LIMITS.voteLimitMin}-${LIMITS.voteLimitMax}`);
  }
  assertOpen(await getBoard(db, boardId));
  await db.update(boards).set({ voteLimit: limit }).where(eq(boards.id, boardId));
}

/** Atomic open→closed transition: of concurrent callers exactly one succeeds, the rest get board_closed. */
export async function closeBoard(db: Db, boardId: string, now: Date): Promise<void> {
  const closed = await db
    .update(boards)
    .set({ status: 'closed', closedAt: now })
    .where(and(eq(boards.id, boardId), eq(boards.status, 'open')))
    .returning({ id: boards.id });
  if (closed.length === 0) {
    await getBoard(db, boardId); // throws not_found for an unknown board
    throw new DomainError('board_closed', 'Board is closed');
  }
}

export async function reopenBoard(db: Db, boardId: string): Promise<void> {
  await db.update(boards).set({ status: 'open', closedAt: null }).where(eq(boards.id, boardId));
}

export async function deleteBoard(db: Db, boardId: string): Promise<void> {
  await db.delete(boards).where(eq(boards.id, boardId));
}
