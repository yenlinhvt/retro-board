import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { actionItems, boards, notes, participants, votes, type Board } from '../db/schema';
import { DomainError } from '../errors';
import type { AppDeps } from '../http/app';
import type { RealtimeLogger } from '../realtime/socket';
import { ConfluenceError, createPage, getPage, updatePage, type ClientCtx } from './confluence-client';
import { getAccessToken, isConnected, RECONNECT_MSG } from './connection-store';
import { pageTitle, renderStorage, type ExportData } from './render';

export type ExportMode = 'auto' | 'overwrite' | 'new';
export type ExportDeps = AppDeps & { notify: (boardId: string) => Promise<void>; log?: RealtimeLogger };

const MSG = {
  notConnected: 'Confluence is not connected — the owner can connect it in Settings',
  noSpace: 'Choose a Confluence space for this board first',
  conflict: 'The Confluence page was edited after the last export',
  noPermission: 'No permission to create pages in this Confluence space',
  parentMissing: 'Parent page not found — pick another',
  titleTaken: 'Export failed: a page with this title already exists',
  internal: 'Export failed: internal error',
};
const MAX_TITLE_SUFFIX = 10;

const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** Board content for the Confluence page. Private notes are never read. */
export async function collectExportData(db: Db, boardId: string, nowMs: number = Date.now()): Promise<ExportData> {
  const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
  if (!board) throw new DomainError('not_found', 'Board not found');
  const people = await db
    .select({ id: participants.id, name: participants.name })
    .from(participants)
    .where(eq(participants.boardId, boardId));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const publicNotes = await db
    .select()
    .from(notes)
    .where(and(eq(notes.boardId, boardId), eq(notes.isPublic, true)));
  const voteRows = await db
    .select({ noteId: votes.noteId, participantId: votes.participantId })
    .from(votes)
    .where(eq(votes.boardId, boardId));
  const items = await db
    .select()
    .from(actionItems)
    .where(eq(actionItems.boardId, boardId))
    .orderBy(asc(actionItems.createdAt), asc(actionItems.id));

  const voteCount = new Map<string, number>();
  for (const v of voteRows) voteCount.set(v.noteId, (voteCount.get(v.noteId) ?? 0) + 1);
  const shared = (n: (typeof publicNotes)[number]) => (n.sharedAt ?? n.createdAt).getTime();
  const sorted = [...publicNotes].sort(
    (a, b) => (voteCount.get(b.id) ?? 0) - (voteCount.get(a.id) ?? 0) || shared(a) - shared(b),
  );

  const contributorIds = new Set([
    ...publicNotes.map((n) => n.authorId),
    ...voteRows.map((v) => v.participantId),
    ...items.map((a) => a.createdBy),
  ]);
  const names = [...new Set([...contributorIds].map((id) => nameOf.get(id)).filter((n): n is string => !!n))];
  const noteText = new Map(publicNotes.map((n) => [n.id, n.text]));

  return {
    boardName: board.name,
    date: (board.closedAt ?? new Date(nowMs)).toISOString().slice(0, 10),
    participants: names.sort(byName),
    columns: board.columns.map((name, i) => ({
      name,
      notes: sorted
        .filter((n) => n.columnIndex === i)
        .map((n) => ({ text: n.text, author: nameOf.get(n.authorId) ?? '', votes: voteCount.get(n.id) ?? 0 })),
    })),
    actionItems: items.map((a) => ({
      text: a.text,
      owner: a.owner,
      noteText: a.noteId ? (noteText.get(a.noteId) ?? null) : null,
    })),
  };
}

type Outcome = Partial<Pick<Board, 'confluencePageId' | 'confluencePageVersion' | 'confluencePageUrl'>> & {
  exportStatus: 'success' | 'conflict' | 'failed';
  exportError: string | null;
};

const running = new Set<string>();

/** Exports a board to Confluence and records the outcome on the board. Never throws. */
export async function exportBoard(deps: ExportDeps, boardId: string, mode: ExportMode): Promise<void> {
  if (running.has(boardId)) return;
  running.add(boardId);
  try {
    await runExport(deps, boardId, mode);
  } catch (err) {
    deps.log?.error({ err, boardId }, 'confluence export failed');
    try {
      await record(deps, boardId, { exportStatus: 'failed', exportError: MSG.internal });
    } catch (recordErr) {
      deps.log?.error({ err: recordErr, boardId }, 'recording export failure failed');
    }
  } finally {
    running.delete(boardId);
  }
}

async function record(deps: ExportDeps, boardId: string, outcome: Outcome): Promise<void> {
  await deps.db.update(boards).set(outcome).where(eq(boards.id, boardId));
  await deps.notify(boardId);
}

async function runExport(deps: ExportDeps, boardId: string, mode: ExportMode): Promise<void> {
  const { db } = deps;
  if (!(await isConnected(db))) {
    if (mode !== 'auto') await record(deps, boardId, { exportStatus: 'failed', exportError: MSG.notConnected });
    return;
  }
  const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
  if (!board) return;
  if (!board.confluenceSpaceId) {
    await record(deps, boardId, { exportStatus: 'failed', exportError: MSG.noSpace });
    return;
  }
  await db.update(boards).set({ exportStatus: 'pending' }).where(eq(boards.id, boardId));
  await deps.notify(boardId);

  let outcome: Outcome;
  try {
    outcome = await publish(deps, board, board.confluenceSpaceId, mode);
  } catch (err) {
    outcome = { exportStatus: 'failed', exportError: errorMessage(deps, err, boardId, board.confluenceParentId) };
  }
  await record(deps, boardId, outcome);
}

async function publish(deps: ExportDeps, board: Board, spaceId: string, mode: ExportMode): Promise<Outcome> {
  const access = await getAccessToken(deps);
  const ctx: ClientCtx = { fetch: deps.fetch, ...access };
  const data = await collectExportData(deps.db, board.id, deps.now());
  const title = pageTitle(data.boardName, data.date);
  const storage = renderStorage(data);

  if (board.confluencePageId && mode !== 'new') {
    const page = await getPage(ctx, board.confluencePageId);
    if (page) {
      if (page.version !== board.confluencePageVersion && mode !== 'overwrite') {
        return { exportStatus: 'conflict', exportError: MSG.conflict };
      }
      // Keep the page's " (n)" suffix so a re-export does not collide with the page that took the base title.
      const kept = TITLE_SUFFIX.exec(page.title)?.[1];
      const preferred = kept ? withSuffix(title, Number(kept)) : title;
      const candidates = [preferred, ...suffixedTitles(title).filter((t) => t !== preferred)];
      for (const candidate of candidates) {
        try {
          return saved(await updatePage(ctx, { id: page.id, title: candidate, storage, version: page.version + 1 }));
        } catch (err) {
          // The page changed between our read and our write.
          if (err instanceof ConfluenceError && err.status === 409) return { exportStatus: 'conflict', exportError: MSG.conflict };
          if (!isTitleConflict(err)) throw err;
        }
      }
      return { exportStatus: 'failed', exportError: MSG.titleTaken };
    }
  }

  for (const candidate of suffixedTitles(title)) {
    try {
      return saved(await createPage(ctx, { spaceId, parentId: board.confluenceParentId, title: candidate, storage }));
    } catch (err) {
      if (!isTitleConflict(err)) throw err;
    }
  }
  return { exportStatus: 'failed', exportError: MSG.titleTaken };
}

const TITLE_SUFFIX = / \((\d+)\)$/;
const withSuffix = (title: string, n: number) => (n === 1 ? title : `${title} (${n})`);
/** The base title, then "title (2)" … "title (10)". */
const suffixedTitles = (title: string) => Array.from({ length: MAX_TITLE_SUFFIX }, (_, i) => withSuffix(title, i + 1));

function saved(page: { id: string; version: number; url: string }): Outcome {
  return {
    exportStatus: 'success',
    exportError: null,
    confluencePageId: page.id,
    confluencePageVersion: page.version,
    confluencePageUrl: page.url,
  };
}

const DUPLICATE = /already exists/i;

/** Confluence's "a page with this title already exists" answer, read from the v2 error body. */
function isTitleConflict(err: unknown): boolean {
  if (!(err instanceof ConfluenceError) || (err.status !== 400 && err.status !== 409)) return false;
  let body: unknown;
  try {
    body = JSON.parse(err.message);
  } catch {
    return DUPLICATE.test(err.message);
  }
  const b = (body ?? {}) as { message?: unknown; errors?: unknown };
  const texts: unknown[] = [b.message];
  if (Array.isArray(b.errors)) {
    for (const e of b.errors as { title?: unknown; detail?: unknown }[]) texts.push(e?.title, e?.detail);
  }
  return texts.some((t) => typeof t === 'string' && DUPLICATE.test(t));
}

function errorMessage(deps: ExportDeps, err: unknown, boardId: string, parentId: string | null): string {
  if (err instanceof DomainError && err.code === 'forbidden') return err.message;
  if (!(err instanceof ConfluenceError)) throw err;
  if (err.status === 401) return RECONNECT_MSG;
  if (err.status === 403) return MSG.noPermission;
  if (err.status === 404 && parentId) return MSG.parentMissing;
  deps.log?.error({ err, boardId, status: err.status }, 'confluence export failed');
  return `Export failed: ${err.status}`;
}
