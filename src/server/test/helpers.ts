import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { migrationsFolder, type Db } from '../db/client';
import * as schema from '../db/schema';
import { createBoard } from '../boards/board-service';
import { upsertParticipant } from '../boards/participant-service';
import type { Participant } from '../db/schema';
import { randomId } from '../security/tokens';

/** Fresh in-memory Postgres (PGlite) with all migrations applied. */
export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return db as unknown as Db;
}

export async function seedBoard(db: Db, opts: { name?: string } = {}): Promise<{ boardId: string; adminToken: string }> {
  const { board, adminToken } = await createBoard(db, { name: opts.name ?? 'Test board' });
  return { boardId: board.id, adminToken };
}

export function seedParticipant(db: Db, boardId: string, name: string): Promise<Participant> {
  return upsertParticipant(db, boardId, randomId(16), name);
}
