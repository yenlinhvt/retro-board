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

export type PoolErrorLogger = (msg: string, err: Error) => void;

/**
 * `onError` receives errors from idle pool clients (e.g. a Postgres restart or failover); without a listener
 * those would crash the process. The pool replaces the broken client on the next query.
 */
export function createDb(
  url: string,
  onError: PoolErrorLogger = (msg, err) => console.error(msg, err),
): { db: Db; pool: pg.Pool; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: url });
  pool.on('error', (err) => onError('postgres pool error', err));
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** Applies pending migrations from `<cwd>/drizzle`. Only for node-postgres databases from `createDb`. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: migrationsFolder() });
}
