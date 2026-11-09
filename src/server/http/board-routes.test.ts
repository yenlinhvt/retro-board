import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io as ioClient } from 'socket.io-client';
import { getBoard } from '../boards/board-service';
import { loadConfig } from '../config';
import { setDefaults } from '../confluence/connection-store';
import type { Db } from '../db/client';
import { createTestDb, fakeConfluence, seedBoard, seedConnection } from '../test/helpers';
import { eq } from 'drizzle-orm';
import { boards } from '../db/schema';
import { DomainError } from '../errors';
import type { Realtime } from '../realtime/socket';
import { buildApp } from './app';

const env = {
  DATABASE_URL: 'postgres://x',
  PUBLIC_BASE_URL: 'https://retro.example.com',
  OWNER_SECRET: 'owner-secret-1234567',
  INVITE_CODES: 'alpha,beta',
  SESSION_SECRET: 's'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

let app: FastifyInstance;

beforeEach(async () => {
  const db = await createTestDb();
  ({ app } = await buildApp({ config: loadConfig(env), db, now: () => Date.now(), fetch }));
});
afterEach(async () => {
  await app.close();
});

const create = (payload: unknown) => app.inject({ method: 'POST', url: '/api/boards', payload: payload as object });

test('creates board with valid invite code', async () => {
  const r = await create({ name: 'Sprint', inviteCode: 'beta' });
  expect(r.statusCode).toBe(201);
  const body = r.json();
  expect(body.participantUrl).toBe(`https://retro.example.com/b/${body.boardId}`);
  expect(body.adminUrl).toBe(`https://retro.example.com/b/${body.boardId}?admin=${body.adminToken}`);
});

test('rejects bad invite code with 403', async () => {
  const r = await create({ name: 'Sprint', inviteCode: 'nope' });
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ error: 'forbidden' });
});

test('rejects missing invite code and non-string fields', async () => {
  expect((await create({ name: 'Sprint' })).statusCode).toBe(403);
  expect((await create({ name: 5, inviteCode: 'alpha' })).statusCode).toBe(400);
});

test('invalid board name gives 400 invalid_input', async () => {
  const r = await create({ name: '   ', inviteCode: 'alpha' });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe('invalid_input');
});

test('rate limits creation attempts after 10/min', async () => {
  for (let i = 0; i < 10; i++) expect((await create({ name: 'S', inviteCode: 'bad' })).statusCode).toBe(403);
  expect((await create({ name: 'S', inviteCode: 'bad' })).statusCode).toBe(429);
});

test('healthz', async () => {
  const r = await app.inject({ method: 'GET', url: '/healthz' });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ ok: true });
});

test('unknown api route is 404 json', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/nope' });
  expect(r.statusCode).toBe(404);
  expect(r.json().error).toBe('not_found');
});

test('request logs never contain the admin query string', async () => {
  const { Writable } = await import('node:stream');
  let out = '';
  const logStream = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } });
  const { app: logged } = await buildApp({ config: loadConfig(env), db: await createTestDb(), now: () => Date.now(), fetch, logStream });
  await logged.inject({ method: 'GET', url: '/x?admin=SECRET' });
  await logged.close();
  expect(out).toContain('"url":"/x"');
  expect(out).not.toContain('SECRET');
});

describe('board Confluence routes', () => {
  let db: Db;
  let boardId: string;
  let adminToken: string;
  let confluence: ReturnType<typeof fakeConfluence>;
  let realtime: Realtime;
  const config = loadConfig(env);

  beforeEach(async () => {
    await app.close();
    db = await createTestDb();
    ({ boardId, adminToken } = await seedBoard(db, { name: 'S' }));
    confluence = fakeConfluence();
    ({ app, realtime } = await buildApp({ config, db, now: () => Date.now(), fetch: confluence.fetch }));
  });

  const call = (method: 'GET' | 'PUT' | 'POST', url: string, opts: { token?: string | null; payload?: object } = {}) =>
    app.inject({
      method,
      url,
      payload: opts.payload,
      headers: opts.token === null ? {} : { 'x-admin-token': opts.token ?? adminToken },
    });
  const target = { spaceId: '100', spaceName: 'Engineering', parentId: null, parentTitle: null };

  test('export routes require admin token', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    const routes = [
      ['GET', `/api/boards/${boardId}/confluence/spaces`, undefined],
      ['GET', `/api/boards/${boardId}/confluence/pages?spaceId=100`, undefined],
      ['PUT', `/api/boards/${boardId}/export-target`, target],
      ['POST', `/api/boards/${boardId}/export`, { mode: 'new' }],
    ] as const;
    for (const [method, url, payload] of routes) {
      for (const token of [null, 'wrong-token']) {
        const r = await call(method, url, { token, payload });
        expect(r.statusCode).toBe(403);
        expect(r.json()).toEqual({ error: 'forbidden' });
      }
      const missing = await call(method, url.replace(boardId, 'nope'), { payload });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'not_found' });
    }
    expect(confluence.state.calls).toEqual([]);
    expect((await getBoard(db, boardId)).exportStatus).toBe('idle');
  });

  test('not connected gives 409', async () => {
    for (const [method, url, payload] of [
      ['GET', `/api/boards/${boardId}/confluence/spaces`, undefined],
      ['GET', `/api/boards/${boardId}/confluence/pages?spaceId=100`, undefined],
      ['PUT', `/api/boards/${boardId}/export-target`, target],
      ['POST', `/api/boards/${boardId}/export`, { mode: 'new' }],
    ] as const) {
      const r = await call(method, url, { payload });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'not_connected' });
    }
  });

  test('lists spaces and pages', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    confluence.pages.set('7', { id: '7', spaceId: '100', parentId: null, title: 'Retros', version: 1, body: '' });
    const spaces = await call('GET', `/api/boards/${boardId}/confluence/spaces?q=eng`);
    expect(spaces.statusCode).toBe(200);
    expect(spaces.json()).toEqual({ spaces: [{ id: '100', key: 'ENG', name: 'Engineering' }] });
    const pages = await call('GET', `/api/boards/${boardId}/confluence/pages?spaceId=100&q=Retros`);
    expect(pages.json()).toEqual({ pages: [{ id: '7', title: 'Retros' }] });
    expect((await call('GET', `/api/boards/${boardId}/confluence/pages`)).statusCode).toBe(400);
  });

  test('Confluence auth failures become 403 with a reconnect message', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    confluence.state.failWith = 401;
    const r = await call('GET', `/api/boards/${boardId}/confluence/spaces`);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'forbidden', message: 'Atlassian connection expired — owner needs to reconnect in Settings' });
  });

  test('PUT export-target validates and stores', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    const notify = vi.spyOn(realtime, 'broadcastBoard');
    const url = `/api/boards/${boardId}/export-target`;
    expect((await call('PUT', url, { payload: { ...target, spaceId: '' } })).statusCode).toBe(400);
    expect((await call('PUT', url, { payload: { ...target, parentTitle: 'x'.repeat(201) } })).statusCode).toBe(400);
    const r = await call('PUT', url, { payload: { spaceId: '100', spaceName: 'Engineering', parentId: '7', parentTitle: 'Retros' } });
    expect(r.statusCode).toBe(200);
    expect(await getBoard(db, boardId)).toMatchObject({
      confluenceSpaceId: '100',
      confluenceSpaceName: 'Engineering',
      confluenceParentId: '7',
      confluenceParentTitle: 'Retros',
    });
    expect(notify).toHaveBeenCalledWith(boardId);
    await call('PUT', url, { payload: { ...target, parentId: '', parentTitle: '' } });
    expect(await getBoard(db, boardId)).toMatchObject({ confluenceParentId: null, confluenceParentTitle: null });
  });

  test('changing the export location forgets the previous page', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    const url = `/api/boards/${boardId}/export-target`;
    const page = { confluencePageId: '9', confluencePageVersion: 2, confluencePageUrl: 'https://x/9' };
    await db.update(boards).set({ ...page, confluenceSpaceId: '100', exportStatus: 'conflict', exportError: 'edited' }).where(eq(boards.id, boardId));

    await call('PUT', url, { payload: { ...target, spaceName: 'Renamed' } }); // same space and parent
    expect(await getBoard(db, boardId)).toMatchObject({ ...page, exportStatus: 'conflict' });

    await call('PUT', url, { payload: { ...target, parentId: '7', parentTitle: 'Retros' } });
    expect(await getBoard(db, boardId)).toMatchObject({
      confluencePageId: null,
      confluencePageVersion: null,
      confluencePageUrl: null,
      exportStatus: 'idle',
      exportError: null,
    });

    await db.update(boards).set({ ...page, exportStatus: 'success' }).where(eq(boards.id, boardId));
    await call('PUT', url, { payload: { ...target, spaceId: '200', spaceName: 'Ops' } });
    expect(await getBoard(db, boardId)).toMatchObject({ confluencePageId: null, exportStatus: 'success' });
  });

  test('a non-forbidden DomainError from the connection is 409 not_connected', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    const store = await import('../confluence/connection-store');
    const spy = vi.spyOn(store, 'getAccessToken').mockRejectedValueOnce(new DomainError('not_found', 'gone'));
    try {
      const r = await call('GET', `/api/boards/${boardId}/confluence/spaces`);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'not_connected' });
    } finally {
      spy.mockRestore();
    }
  });

  test('POST export returns 202 and exports in the background (open board)', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    await call('PUT', `/api/boards/${boardId}/export-target`, { payload: target });
    expect((await call('POST', `/api/boards/${boardId}/export`, { payload: { mode: 'bogus' } })).statusCode).toBe(400);
    const r = await call('POST', `/api/boards/${boardId}/export`, { payload: { mode: 'new' } });
    expect(r.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await getBoard(db, boardId)).exportStatus).toBe('success'));
    expect(confluence.pages.size).toBe(1);
  });

  test('new boards take the owner defaults and closing auto-exports', async () => {
    await seedConnection(db, config.encryptionKey, Date.now());
    await setDefaults(db, { spaceId: '100', spaceName: 'Engineering', parentId: null, parentTitle: null }, Date.now());
    const created = await create({ name: 'Sprint', inviteCode: 'alpha' });
    const { boardId: id, adminToken: token } = created.json();
    expect(await getBoard(db, id)).toMatchObject({ confluenceSpaceId: '100', confluenceSpaceName: 'Engineering' });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    const socket = ioClient(`http://127.0.0.1:${addr.port}`, {
      transports: ['websocket'],
      auth: { boardId: id, participantId: 'p1', name: 'Boss', adminToken: token },
      reconnection: false,
      forceNew: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('board:state', () => resolve());
        socket.once('connect_error', reject);
      });
      expect(await socket.timeout(5000).emitWithAck('admin:close', {})).toEqual({ ok: true });
      await vi.waitFor(async () => expect((await getBoard(db, id)).exportStatus).toBe('success'));
      expect([...confluence.pages.values()][0]!.title).toMatch(/^Retro – Sprint – \d{4}-\d{2}-\d{2}$/);
    } finally {
      socket.disconnect();
    }
  });
});
