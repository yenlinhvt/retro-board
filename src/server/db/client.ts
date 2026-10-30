import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function migrationsFolder(): string {
  return path.resolve(process.cwd(), 'drizzle');
}

export function createDb(url: string): { db: Db; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}

/** Applies pending migrations from `<cwd>/drizzle`. Only for node-postgres databases from `createDb`. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: migrationsFolder() });
}
