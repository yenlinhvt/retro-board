import { and, eq } from 'drizzle-orm';
import { LIMITS } from '../../shared/constants';
import { assertOpen, getBoard } from '../boards/board-service';
import type { Db } from '../db/client';
import { actionItems, notes, type ActionItem } from '../db/schema';
import { DomainError } from '../errors';

export type { ActionItem };

export type ActionActor = { participantId: string; isAdmin: boolean };
export type ActionItemInput = { text: string; owner: string };

function validInput(input: ActionItemInput): ActionItemInput {
  const text = input.text.trim();
  const owner = input.owner.trim();
  if (text.length < 1 || text.length > LIMITS.actionText) {
    throw new DomainError('invalid_input', `Action item must be 1-${LIMITS.actionText} characters`);
  }
  if (owner.length > LIMITS.actionOwner) {
    throw new DomainError('invalid_input', `Owner must be at most ${LIMITS.actionOwner} characters`);
  }
  return { text, owner };
}

async function findEditableItem(db: Db, boardId: string, actor: ActionActor, id: string): Promise<ActionItem> {
  const [item] = await db.select().from(actionItems).where(and(eq(actionItems.id, id), eq(actionItems.boardId, boardId)));
  if (!item) throw new DomainError('not_found', 'Action item not found');
  if (item.createdBy !== actor.participantId && !actor.isAdmin) {
    throw new DomainError('forbidden', 'Only the creator or an admin can change this action item');
  }
  return item;
}

export async function addActionItem(
  db: Db,
  boardId: string,
  creatorId: string,
  input: ActionItemInput & { noteId: string | null },
): Promise<ActionItem> {
  const { text, owner } = validInput(input);
  assertOpen(await getBoard(db, boardId));
  if (input.noteId !== null) {
    const [note] = await db
      .select({ isPublic: notes.isPublic })
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.boardId, boardId)));
    if (!note?.isPublic) throw new DomainError('invalid_input', 'Linked note must be a shared note on this board');
  }
  const [item] = await db
    .insert(actionItems)
    .values({ id: crypto.randomUUID(), boardId, text, owner, noteId: input.noteId, createdBy: creatorId })
    .returning();
  return item!;
}

export async function editActionItem(db: Db, boardId: string, actor: ActionActor, id: string, input: ActionItemInput): Promise<void> {
  const { text, owner } = validInput(input);
  assertOpen(await getBoard(db, boardId));
  await findEditableItem(db, boardId, actor, id);
  await db.update(actionItems).set({ text, owner }).where(eq(actionItems.id, id));
}

export async function deleteActionItem(db: Db, boardId: string, actor: ActionActor, id: string): Promise<void> {
  assertOpen(await getBoard(db, boardId));
  await findEditableItem(db, boardId, actor, id);
  await db.delete(actionItems).where(eq(actionItems.id, id));
}
