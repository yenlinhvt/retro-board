import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { ActionItemView, BoardSnapshot, ExportStatus, ExportView, NoteView, ParticipantView } from '../../shared/types';
import { getBoard, type Board } from '../boards/board-service';
import type { Db } from '../db/client';
import { actionItems, notes, participants, votes } from '../db/schema';

export type SnapshotViewer = { participantId: string; isAdmin: boolean };
export type SnapshotOptions = { onlinePublicIds: Set<string>; confluenceConnected: boolean; now: number };

function exportView(board: Board, confluenceConnected: boolean): ExportView {
  return {
    status: confluenceConnected ? (board.exportStatus as ExportStatus) : 'not_connected',
    pageUrl: board.confluencePageUrl,
    error: board.exportError,
    spaceId: board.confluenceSpaceId,
    spaceName: board.confluenceSpaceName,
    parentId: board.confluenceParentId,
    parentTitle: board.confluenceParentTitle,
  };
}

/** Builds the board state as `viewer` may see it, in a fixed number of queries. Never includes secrets or internal ids. */
export async function buildSnapshot(db: Db, boardId: string, viewer: SnapshotViewer, opts: SnapshotOptions): Promise<BoardSnapshot> {
  const board = await getBoard(db, boardId);

  const [participantRows, noteRows, voteRows, actionRows] = await Promise.all([
    db.select().from(participants).where(eq(participants.boardId, boardId)).orderBy(asc(participants.createdAt)),
    db
      .select()
      .from(notes)
      .where(and(eq(notes.boardId, boardId), or(eq(notes.isPublic, true), eq(notes.authorId, viewer.participantId))))
      .orderBy(asc(notes.createdAt)),
    db
      .select({
        noteId: votes.noteId,
        total: sql<number>`count(*)::int`,
        mine: sql<number>`(count(*) filter (where ${votes.participantId} = ${viewer.participantId}))::int`,
      })
      .from(votes)
      .where(eq(votes.boardId, boardId))
      .groupBy(votes.noteId),
    db.select().from(actionItems).where(eq(actionItems.boardId, boardId)).orderBy(asc(actionItems.createdAt)),
  ]);

  const byInternalId = new Map(participantRows.map((p) => [p.id, p]));
  const voteCounts = new Map(voteRows.map((v) => [v.noteId, v]));
  const viewerVotes = voteRows.reduce((sum, v) => sum + v.mine, 0);

  const noteViews: NoteView[] = noteRows.map((n) => {
    const author = byInternalId.get(n.authorId);
    const counts = voteCounts.get(n.id);
    return {
      id: n.id,
      columnIndex: n.columnIndex,
      text: n.text,
      authorPublicId: author?.publicId ?? '',
      authorName: author?.name ?? '',
      isPublic: n.isPublic,
      isMine: n.authorId === viewer.participantId,
      votes: counts?.total ?? 0,
      myVotes: counts?.mine ?? 0,
      createdAt: n.createdAt.toISOString(),
      sharedAt: n.sharedAt ? n.sharedAt.toISOString() : null,
    };
  });

  const participantViews: ParticipantView[] = participantRows.map((p) => ({
    publicId: p.publicId,
    name: p.name,
    online: opts.onlinePublicIds.has(p.publicId),
    isMe: p.id === viewer.participantId,
  }));

  const actionViews: ActionItemView[] = actionRows.map((a) => ({
    id: a.id,
    text: a.text,
    owner: a.owner,
    noteId: a.noteId,
    canEdit: viewer.isAdmin || a.createdBy === viewer.participantId,
    createdAt: a.createdAt.toISOString(),
  }));

  return {
    id: board.id,
    name: board.name,
    status: board.status,
    columns: board.columns,
    voteLimit: board.voteLimit,
    votesRemaining: Math.max(0, board.voteLimit - viewerVotes),
    notes: noteViews,
    participants: participantViews,
    actionItems: actionViews,
    timer: board.timer,
    isAdmin: viewer.isAdmin,
    export: viewer.isAdmin ? exportView(board, opts.confluenceConnected) : null,
    serverNow: opts.now,
  };
}
