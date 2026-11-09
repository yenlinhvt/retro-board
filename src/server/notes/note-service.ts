import { and, eq } from 'drizzle-orm';
import { COLUMN_COUNT, LIMITS } from '../../shared/constants';
import { assertOpen, getBoard } from '../boards/board-service';
import type { Db } from '../db/client';
import { notes, type Note } from '../db/schema';
import { DomainError } from '../errors';

export type { Note };

export type NoteActor = { participantId: string; isAdmin: boolean };

function validText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > LIMITS.noteText) {
    throw new DomainError('invalid_input', `Note must be 1-${LIMITS.noteText} characters`);
  }
  return trimmed;
}

/** Loads a note on this board that the actor may know exists: public notes, or their own private ones. */
async function findVisibleNote(db: Db, boardId: string, participantId: string, noteId: string): Promise<Note> {
  const [note] = await db.select().from(notes).where(and(eq(notes.id, noteId), eq(notes.boardId, boardId)));
  if (!note || (!note.isPublic && note.authorId !== participantId)) throw new DomainError('not_found', 'Note not found');
  return note;
}

async function openBoard(db: Db, boardId: string): Promise<void> {
  assertOpen(await getBoard(db, boardId));
}

export async function addNote(db: Db, boardId: string, authorId: string, columnIndex: number, text: string): Promise<Note> {
  const clean = validText(text);
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= COLUMN_COUNT) {
    throw new DomainError('invalid_input', 'Invalid column index');
  }
  await openBoard(db, boardId);
  const [note] = await db
    .insert(notes)
    .values({ id: crypto.randomUUID(), boardId, authorId, columnIndex, text: clean })
    .returning();
  return note!;
}

export async function editNote(db: Db, boardId: string, actorId: string, noteId: string, text: string): Promise<void> {
  const clean = validText(text);
  await openBoard(db, boardId);
  const note = await findVisibleNote(db, boardId, actorId, noteId);
  if (note.authorId !== actorId) throw new DomainError('forbidden', 'Only the author can edit this note');
  await db.update(notes).set({ text: clean, updatedAt: new Date() }).where(eq(notes.id, noteId));
}

export async function shareNote(db: Db, boardId: string, actorId: string, noteId: string): Promise<void> {
  await openBoard(db, boardId);
  const note = await findVisibleNote(db, boardId, actorId, noteId);
  if (note.authorId !== actorId) throw new DomainError('forbidden', 'Only the author can share this note');
  if (note.isPublic) return;
  await db.update(notes).set({ isPublic: true, sharedAt: new Date() }).where(eq(notes.id, noteId));
}

export async function deleteNote(db: Db, boardId: string, actor: NoteActor, noteId: string): Promise<void> {
  await openBoard(db, boardId);
  const note = await findVisibleNote(db, boardId, actor.participantId, noteId);
  if (note.authorId !== actor.participantId && !actor.isAdmin) {
    throw new DomainError('forbidden', 'Only the author or an admin can delete this note');
  }
  await db.delete(notes).where(eq(notes.id, noteId));
}
