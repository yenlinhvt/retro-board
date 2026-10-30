import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { migrationsFolder, type Db } from '../db/client';
import * as schema from '../db/schema';
import { participants, type Participant } from '../db/schema';
import { randomId } from '../security/tokens';

/** Fresh in-memory Postgres (PGlite) with all migrations applied. */
export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return db as unknown as Db;
}

export async function seedParticipant(db: Db, boardId: string, name: string): Promise<Participant> {
  const [row] = await db
    .insert(participants)
    .values({ id: randomId(16), boardId, clientId: randomId(16), publicId: randomId(8), name })
    .returning();
  return row!;
}
