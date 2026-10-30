import { and, count, eq } from 'drizzle-orm';
import { assertOpen, getBoard } from '../boards/board-service';
import type { Db } from '../db/client';
import { notes, participants, votes } from '../db/schema';
import { DomainError } from '../errors';

/**
 * The transaction row-locks the participant, so concurrent votes by the same participant
 * serialise and the count-then-insert below cannot overshoot the limit.
 */
export async function addVote(db: Db, boardId: string, participantId: string, noteId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const board = await getBoard(tx as unknown as Db, boardId);
    assertOpen(board);
    const [participant] = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.boardId, boardId)))
      .for('update');
    if (!participant) throw new DomainError('not_found', 'Participant not found');
    const [note] = await tx
      .select({ isPublic: notes.isPublic })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.boardId, boardId)));
    if (!note || !note.isPublic) throw new DomainError('not_found', 'Note not found');
    const [used] = await tx
      .select({ n: count() })
      .from(votes)
      .where(and(eq(votes.boardId, boardId), eq(votes.participantId, participantId)));
    if (used!.n >= board.voteLimit) throw new DomainError('vote_limit_reached', 'No votes remaining');
    await tx.insert(votes).values({ id: crypto.randomUUID(), boardId, noteId, participantId });
  });
}

export async function removeVote(db: Db, boardId: string, participantId: string, noteId: string): Promise<void> {
  assertOpen(await getBoard(db, boardId));
  await db.transaction(async (tx) => {
    const [vote] = await tx
      .select({ id: votes.id })
      .from(votes)
      .where(and(eq(votes.boardId, boardId), eq(votes.participantId, participantId), eq(votes.noteId, noteId)))
      .limit(1)
      .for('update');
    if (vote) await tx.delete(votes).where(eq(votes.id, vote.id));
  });
}
