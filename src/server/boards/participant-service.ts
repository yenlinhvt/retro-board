import { eq, sql } from 'drizzle-orm';
import { LIMITS } from '../../shared/constants';
import type { Db } from '../db/client';
import { participants, type Participant } from '../db/schema';
import { DomainError } from '../errors';
import { randomId } from '../security/tokens';

export type { Participant };

function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > LIMITS.displayName) {
    throw new DomainError('invalid_input', `Display name must be 1-${LIMITS.displayName} characters`);
  }
  return trimmed;
}

/** One participant per (board, clientId); re-joining updates the display name. */
export async function upsertParticipant(db: Db, boardId: string, clientId: string, name: string): Promise<Participant> {
  const clean = validName(name);
  const [row] = await db
    .insert(participants)
    .values({ id: crypto.randomUUID(), boardId, clientId, publicId: randomId(8), name: clean })
    .onConflictDoUpdate({ target: [participants.boardId, participants.clientId], set: { name: sql`excluded.name` } })
    .returning();
  return row!;
}

export async function renameParticipant(db: Db, participantId: string, name: string): Promise<void> {
  await db.update(participants).set({ name: validName(name) }).where(eq(participants.id, participantId));
}
