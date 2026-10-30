import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { migrationsFolder, type Db } from '../db/client';
import * as schema from '../db/schema';
import { createBoard } from '../boards/board-service';
import { upsertParticipant } from '../boards/participant-service';
import type { Participant } from '../db/schema';
import { randomId } from '../security/tokens';
import { saveTokens, setSite } from '../confluence/connection-store';

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

/** Stores a valid (non-expiring) Atlassian connection with a chosen site. */
export async function seedConnection(db: Db, key: Buffer, nowMs: number): Promise<void> {
  await saveTokens(db, key, { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(nowMs + 3_600_000) }, nowMs);
  await setSite(db, { id: 'cloud-1', url: 'https://x.atlassian.net', name: 'X' }, nowMs);
}

export type FakePage = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  version: number;
  body: string;
  status?: 'current' | 'trashed' | 'archived';
};

/** Confluence v2 error body shape. */
const v2Error = (status: number, title: string) => ({ errors: [{ status, code: 'ERROR', title, detail: null }] });

/**
 * In-memory Confluence v2 API behind a fetch function. Set `failWith` to make every call answer that status;
 * `beforePut` runs just before a page update is checked (to simulate a concurrent edit).
 */
export function fakeConfluence() {
  const pages = new Map<string, FakePage>();
  const spaces = [{ id: '100', key: 'ENG', name: 'Engineering' }, { id: '200', key: 'OPS', name: 'Ops' }];
  const state = {
    failWith: null as number | null,
    calls: [] as string[],
    beforePut: null as ((page: FakePage) => void) | null,
  };
  let nextId = 1;
  const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const view = (p: FakePage) => ({
    id: p.id,
    status: p.status ?? 'current',
    title: p.title,
    version: { number: p.version },
    _links: { webui: `/spaces/S/pages/${p.id}` },
  });
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input);
    const path = url.pathname.replace(/^\/ex\/confluence\/[^/]+\/wiki\/api\/v2/, '');
    state.calls.push(`${method} ${path}`);
    if (state.failWith) return j(state.failWith, v2Error(state.failWith, 'Request failed'));
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (method === 'GET' && path === '/spaces') return j(200, { results: spaces });
    const m = path.match(/^\/spaces\/([^/]+)\/pages$/);
    if (method === 'GET' && m) {
      const title = url.searchParams.get('title');
      const results = [...pages.values()].filter((p) => p.spaceId === m[1] && (!title || p.title === title));
      return j(200, { results: results.map((p) => ({ id: p.id, title: p.title })) });
    }
    if (method === 'POST' && path === '/pages') {
      if (body.parentId && !pages.has(body.parentId)) return j(404, v2Error(404, 'Parent page not found'));
      const live = [...pages.values()].filter((p) => (p.status ?? 'current') === 'current');
      if (live.some((p) => p.spaceId === body.spaceId && p.title === body.title)) {
        return j(400, v2Error(400, 'A page with this title already exists: A page already exists with the same TITLE in this space'));
      }
      const p: FakePage = { id: String(nextId++), spaceId: body.spaceId, parentId: body.parentId ?? null, title: body.title, version: 1, body: body.body.value };
      pages.set(p.id, p);
      return j(200, view(p));
    }
    const pm = path.match(/^\/pages\/([^/]+)$/);
    const page = pm ? pages.get(decodeURIComponent(pm[1]!)) : undefined;
    if (pm && !page) return j(404, v2Error(404, 'Not found'));
    if (method === 'GET' && page) return j(200, view(page));
    if (method === 'PUT' && page) {
      state.beforePut?.(page);
      if (body.version.number !== page.version + 1) return j(409, v2Error(409, 'Version must be incremented'));
      Object.assign(page, { title: body.title, version: body.version.number, body: body.body.value });
      return j(200, view(page));
    }
    return j(404, {});
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, pages, state };
}
