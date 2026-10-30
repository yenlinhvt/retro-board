import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Ack, BoardSnapshot, JoinAuth } from '../../shared/types';
import { getBoard } from '../boards/board-service';
import { loadConfig } from '../config';
import type { Db } from '../db/client';
import { DomainError } from '../errors';
import { buildApp, type AppDeps } from '../http/app';
import { createTestDb, seedBoard } from '../test/helpers';

const env = {
  DATABASE_URL: 'postgres://x',
  PUBLIC_BASE_URL: 'https://retro.example.com',
  OWNER_SECRET: 'owner-secret-1234567',
  INVITE_CODES: 'alpha',
  SESSION_SECRET: 's'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

type Client = {
  socket: ClientSocket;
  states: BoardSnapshot[];
  last(): BoardSnapshot;
  /** Resolves with the first future board:state matching `pred`. */
  waitFor(pred: (s: BoardSnapshot) => boolean): Promise<BoardSnapshot>;
};

let db: Db;
let app: FastifyInstance;
let url: string;
let boardId: string;
let adminToken: string;
let clock: number;
let onClosed: ReturnType<typeof vi.fn>;
let logs: string;
const clients: ClientSocket[] = [];

async function start(overrides: Partial<AppDeps> = {}): Promise<void> {
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => (logs += chunk.toString()));
  ({ app } = await buildApp({
    config: loadConfig(env),
    db,
    now: () => clock,
    fetch,
    logStream,
    onClosed,
    ...overrides,
  }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  url = `http://127.0.0.1:${addr.port}`;
}

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 30, 9);
  logs = '';
  onClosed = vi.fn();
  db = await createTestDb();
  ({ boardId, adminToken } = await seedBoard(db));
  await start();
});

afterEach(async () => {
  for (const s of clients.splice(0)) s.disconnect();
  await app.close();
});

function connect(auth: Partial<JoinAuth> | Record<string, unknown>): Client {
  const socket = ioClient(url, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
  clients.push(socket);
  const states: BoardSnapshot[] = [];
  const waiters: { pred: (s: BoardSnapshot) => boolean; resolve: (s: BoardSnapshot) => void }[] = [];
  socket.on('board:state', (s: BoardSnapshot) => {
    states.push(s);
    for (const w of [...waiters]) {
      if (w.pred(s)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(s);
      }
    }
  });
  return {
    socket,
    states,
    last: () => states[states.length - 1]!,
    waitFor: (pred) => new Promise((resolve) => waiters.push({ pred, resolve })),
  };
}

let seq = 0;
async function join(opts: { name: string; participantId?: string; adminToken?: string }): Promise<Client> {
  const c = connect({ boardId, participantId: opts.participantId ?? `client-${++seq}`, name: opts.name, adminToken: opts.adminToken });
  await new Promise<void>((resolve, reject) => {
    c.socket.once('connect_error', reject);
    c.waitFor(() => true).then(() => resolve());
  });
  return c;
}

function connectError(auth: Record<string, unknown>): Promise<string> {
  const c = connect(auth);
  return new Promise((resolve, reject) => {
    c.socket.once('connect_error', (err) => resolve(err.message));
    c.socket.once('connect', () => reject(new Error('unexpectedly connected')));
  });
}

function emit(c: Client, event: string, payload: unknown): Promise<Ack> {
  return c.socket.timeout(5000).emitWithAck(event, payload);
}

function errorOf(a: Ack): string | undefined {
  return a.ok ? undefined : a.error;
}

/** Broadcasts are delivered in order, so once a marker rename is visible every earlier broadcast has arrived. */
async function settle(c: Client): Promise<void> {
  const marker = `sync-${++seq}`;
  const seen = c.waitFor((s) => s.participants.some((p) => p.isMe && p.name === marker));
  expect(await emit(c, 'participant:rename', { name: marker })).toEqual({ ok: true });
  await seen;
}

async function addAndGetId(c: Client, p: { columnIndex: number; text: string }): Promise<{ noteId: string }> {
  const seen = c.waitFor((s) => s.notes.some((n) => n.text === p.text));
  expect(await emit(c, 'note:add', p)).toEqual({ ok: true });
  const s = await seen;
  return { noteId: s.notes.find((n) => n.text === p.text)!.id };
}

test('private note reaches only its author; sharing reaches everyone', async () => {
  const ann = await join({ name: 'Ann' });
  const bob = await join({ name: 'Bob' });
  const admin = await join({ name: 'Boss', adminToken });
  const { noteId } = await addAndGetId(ann, { columnIndex: 0, text: 'secret' });
  const bobSees = bob.waitFor((s) => s.notes.length === 1);
  const adminSees = admin.waitFor((s) => s.notes.length === 1);
  expect(await emit(ann, 'note:share', { noteId })).toEqual({ ok: true });
  expect((await bobSees).notes[0]).toMatchObject({ text: 'secret', authorName: 'Ann', isPublic: true, isMine: false });
  await adminSees;
  // Broadcasts are ordered, so every state bob/admin received before the share is in `states` — none may carry the private note.
  for (const s of [...bob.states, ...admin.states]) {
    expect(s.notes.every((n) => n.isPublic)).toBe(true);
    if (s.notes.length === 0) expect(JSON.stringify(s)).not.toContain('secret');
  }
});

test('snapshots carry no internal ids or secrets', async () => {
  const ann = await join({ name: 'Ann', participantId: 'ann-client-id' });
  const both = ann.waitFor((st) => st.participants.length === 2);
  await join({ name: 'Boss', adminToken });
  const s = await both;
  const json = JSON.stringify(s);
  expect(json).not.toContain('ann-client-id');
  expect(json).not.toContain(adminToken);
});

test('participant link cannot run admin events', async () => {
  const bob = await join({ name: 'Bob' });
  for (const [event, payload] of [
    ['admin:close', {}],
    ['admin:reopen', {}],
    ['admin:delete', {}],
    ['admin:renameColumn', { columnIndex: 0, name: 'X' }],
    ['admin:setVoteLimit', { limit: 9 }],
    ['admin:timer', { type: 'reset' }],
  ] as const) {
    expect(await emit(bob, event, payload)).toEqual({ ok: false, error: 'forbidden', message: expect.any(String) });
  }
  const board = await getBoard(db, boardId);
  expect(board.status).toBe('open');
  expect(board.voteLimit).toBe(5);
});

test('wrong admin token joins as non-admin', async () => {
  const eve = await join({ name: 'Eve', adminToken: 'not-the-token' });
  expect(eve.last()).toMatchObject({ isAdmin: false, export: null });
  expect((await emit(eve, 'admin:close', {})).ok).toBe(false);
  const admin = await join({ name: 'Boss', adminToken });
  expect(admin.last().isAdmin).toBe(true);
  expect(admin.last().export).toMatchObject({ status: 'not_connected' });
});

test('unknown board → connect_error not_found', async () => {
  expect(await connectError({ boardId: 'nope', participantId: 'p1', name: 'Ann' })).toBe('not_found');
});

test('malformed handshake → connect_error invalid_input', async () => {
  const bad: Record<string, unknown>[] = [
    { boardId, participantId: '', name: 'Ann' },
    { boardId, participantId: 'x'.repeat(101), name: 'Ann' },
    { boardId, participantId: 5, name: 'Ann' },
    { boardId, participantId: 'p1', name: '   ' },
    { boardId, participantId: 'p1', name: 'x'.repeat(41) },
    { boardId, participantId: 'p1' },
    { boardId: 7, participantId: 'p1', name: 'Ann' },
  ];
  for (const auth of bad) expect(await connectError(auth)).toBe('invalid_input');
});

test('same participant in two tabs receives private notes in both', async () => {
  const t1 = await join({ name: 'Ann', participantId: 'same' });
  const t2 = await join({ name: 'Ann', participantId: 'same' });
  const seen = t2.waitFor((s) => s.notes.length === 1);
  expect(await emit(t1, 'note:add', { columnIndex: 1, text: 'mine' })).toEqual({ ok: true });
  const s = await seen;
  expect(s.notes.map((n) => n.text)).toEqual(['mine']);
  expect(s.notes[0]!.isMine).toBe(true);
  expect(s.participants).toHaveLength(1);
  expect(s.participants.filter((p) => p.online)).toHaveLength(1);
});

test('presence: closing one of two tabs keeps the participant online; closing both marks offline', async () => {
  const bob = await join({ name: 'Bob' });
  const t1 = await join({ name: 'Ann', participantId: 'ann' });
  const t2 = await join({ name: 'Ann', participantId: 'ann' });
  const annOnline = (s: BoardSnapshot) => s.participants.find((p) => p.name === 'Ann')!.online;
  await settle(bob);
  const afterFirst = bob.waitFor(() => true);
  t1.socket.disconnect();
  expect(annOnline(await afterFirst)).toBe(true);
  const afterSecond = bob.waitFor(() => true);
  t2.socket.disconnect();
  expect(annOnline(await afterSecond)).toBe(false);
});

test('reconnect receives full fresh state', async () => {
  const ann = await join({ name: 'Ann' });
  const bob = await join({ name: 'Bob' });
  const bobOffline = ann.waitFor((s) => s.participants.some((p) => p.name === 'Bob' && !p.online));
  bob.socket.disconnect();
  await bobOffline;
  const { noteId } = await addAndGetId(ann, { columnIndex: 2, text: 'while you were away' });
  expect(await emit(ann, 'note:share', { noteId })).toEqual({ ok: true });
  const fresh = bob.waitFor(() => true);
  bob.socket.connect();
  const s = await fresh;
  expect(s.notes.map((n) => n.text)).toEqual(['while you were away']);
  expect(s.participants.find((p) => p.name === 'Bob')).toMatchObject({ online: true, isMe: true });
});

test('closed board rejects writes with board_closed; reopen re-enables', async () => {
  const admin = await join({ name: 'Boss', adminToken });
  const ann = await join({ name: 'Ann' });
  const closed = ann.waitFor((s) => s.status === 'closed');
  expect(await emit(admin, 'admin:close', {})).toEqual({ ok: true });
  await closed;
  expect(await emit(ann, 'note:add', { columnIndex: 0, text: 'late' })).toEqual({
    ok: false,
    error: 'board_closed',
    message: expect.any(String),
  });
  expect(errorOf(await emit(ann, 'participant:rename', { name: 'Annie' }))).toBe('board_closed');
  expect(errorOf(await emit(admin, 'admin:timer', { type: 'start', durationMs: 60_000 }))).toBe('board_closed');
  const reopened = ann.waitFor((s) => s.status === 'open');
  expect(await emit(admin, 'admin:reopen', {})).toEqual({ ok: true });
  await reopened;
  expect(await emit(ann, 'note:add', { columnIndex: 0, text: 'late' })).toEqual({ ok: true });
});

test('admin events update state for everyone', async () => {
  const admin = await join({ name: 'Boss', adminToken });
  const ann = await join({ name: 'Ann' });
  const updated = ann.waitFor((s) => s.columns[0] === 'Wins' && s.voteLimit === 3 && s.timer.status === 'running');
  expect(await emit(admin, 'admin:renameColumn', { columnIndex: 0, name: 'Wins' })).toEqual({ ok: true });
  expect(await emit(admin, 'admin:setVoteLimit', { limit: 3 })).toEqual({ ok: true });
  expect(await emit(admin, 'admin:timer', { type: 'start', durationMs: 60_000 })).toEqual({ ok: true });
  const s = await updated;
  expect(s.timer.endsAt).toBe(clock + 60_000);
  expect(s.serverNow).toBe(clock);
});

test('participant events: votes, action items, rename, edit and delete', async () => {
  const ann = await join({ name: 'Ann' });
  const { noteId } = await addAndGetId(ann, { columnIndex: 0, text: 'v' });
  const mid = ann.waitFor((st) => st.actionItems.length === 1 && st.participants[0]!.name === 'Annie');
  expect(await emit(ann, 'note:edit', { noteId, text: 'v2' })).toEqual({ ok: true });
  expect(await emit(ann, 'note:share', { noteId })).toEqual({ ok: true });
  expect(await emit(ann, 'vote:add', { noteId })).toEqual({ ok: true });
  expect(await emit(ann, 'vote:add', { noteId })).toEqual({ ok: true });
  expect(await emit(ann, 'vote:remove', { noteId })).toEqual({ ok: true });
  expect(await emit(ann, 'action:add', { text: 'do it', owner: 'Ann', noteId })).toEqual({ ok: true });
  expect(await emit(ann, 'participant:rename', { name: 'Annie' })).toEqual({ ok: true });
  const s = await mid;
  expect(s.notes[0]).toMatchObject({ text: 'v2', votes: 1, myVotes: 1 });
  const id = s.actionItems[0]!.id;
  const cleared = ann.waitFor((st) => st.actionItems.length === 0 && st.notes.length === 0);
  expect(await emit(ann, 'action:edit', { id, text: 'done', owner: '' })).toEqual({ ok: true });
  expect(await emit(ann, 'action:delete', { id })).toEqual({ ok: true });
  expect(await emit(ann, 'note:delete', { noteId })).toEqual({ ok: true });
  const end = await cleared;
  expect(end.votesRemaining).toBe(5);
});

test('domain errors are mapped to acks', async () => {
  const ann = await join({ name: 'Ann' });
  const bob = await join({ name: 'Bob' });
  const { noteId } = await addAndGetId(ann, { columnIndex: 0, text: 'mine' });
  expect(errorOf(await emit(bob, 'note:share', { noteId }))).toBe('not_found');
  expect(errorOf(await emit(bob, 'note:edit', { noteId, text: 'x' }))).toBe('not_found');
  expect(errorOf(await emit(ann, 'note:add', { columnIndex: 9, text: 'x' }))).toBe('invalid_input');
});

test('malformed payloads ack invalid_input and never crash the server', async () => {
  const admin = await join({ name: 'Boss', adminToken });
  const bad: [string, unknown][] = [
    ['note:add', 'garbage'],
    ['note:add', null],
    ['note:add', { columnIndex: '0', text: 'x' }],
    ['note:edit', { noteId: 1, text: 'x' }],
    ['note:share', []],
    ['vote:add', {}],
    ['action:add', { text: 'x', owner: 'y' }],
    ['action:edit', { id: 'a', text: 'x' }],
    ['participant:rename', { name: { toString: 'x' } }],
    ['admin:renameColumn', { columnIndex: 0.5, name: 'x' }],
    ['admin:setVoteLimit', { limit: 'NaN' }],
    ['admin:timer', { type: 'explode' }],
    ['admin:timer', { type: 'start' }],
  ];
  for (const [event, payload] of bad) {
    expect(await emit(admin, event, payload)).toEqual({ ok: false, error: 'invalid_input', message: expect.any(String) });
  }
  // No ack function at all, and an ack passed in the payload position.
  const added = admin.waitFor((s) => s.notes.some((n) => n.text === 'no ack'));
  admin.socket.emit('note:add', { columnIndex: 0, text: 'no ack' });
  const ackOnly = await admin.socket.timeout(5000).emitWithAck('note:edit');
  expect(ackOnly).toMatchObject({ ok: false, error: 'invalid_input' });
  await added;
  expect((await getBoard(db, boardId)).timer.status).toBe('idle');
});

test('unexpected errors ack internal and are logged', async () => {
  const ann = await join({ name: 'Ann' });
  // Postgres rejects NUL bytes in text: a non-DomainError from the service.
  expect(await emit(ann, 'note:add', { columnIndex: 0, text: 'a\u0000b' })).toEqual({
    ok: false,
    error: 'internal',
    message: expect.any(String),
  });
  expect(logs).toMatch(/"level":50/);
  expect(await emit(ann, 'note:add', { columnIndex: 0, text: 'fine' })).toEqual({ ok: true });
});

test('delete emits board:deleted and disconnects', async () => {
  const admin = await join({ name: 'Boss', adminToken });
  const ann = await join({ name: 'Ann' });
  const deleted = new Promise<void>((r) => ann.socket.once('board:deleted', () => r()));
  const disconnected = new Promise<string>((r) => ann.socket.once('disconnect', (reason) => r(reason)));
  expect(await emit(admin, 'admin:delete', {})).toEqual({ ok: true });
  await deleted;
  expect(await disconnected).toBe('io server disconnect');
  await expect(getBoard(db, boardId)).rejects.toBeInstanceOf(DomainError);
  expect(await connectError({ boardId, participantId: 'p', name: 'Ann' })).toBe('not_found');
});

test('31st rapid event is rate_limited', async () => {
  const ann = await join({ name: 'Ann' });
  // Clock is frozen, so the bucket does not refill; invalid payloads keep the burst cheap.
  const acks = await Promise.all(Array.from({ length: 31 }, () => emit(ann, 'note:add', {})));
  expect(acks.slice(0, 30).every((a) => !a.ok && a.error === 'invalid_input')).toBe(true);
  expect(acks[30]).toEqual({ ok: false, error: 'rate_limited', message: expect.any(String) });
  clock += 1000; // refills 3 tokens
  expect(await emit(ann, 'note:add', { columnIndex: 0, text: 'ok again' })).toEqual({ ok: true });
});

test('close calls onClosed once', async () => {
  const admin = await join({ name: 'Boss', adminToken });
  const called = new Promise<void>((r) => onClosed.mockImplementation(() => r()));
  expect(await emit(admin, 'admin:close', {})).toEqual({ ok: true });
  await called;
  expect(onClosed).toHaveBeenCalledWith(boardId);
  expect(errorOf(await emit(admin, 'admin:close', {}))).toBe('board_closed');
  expect(onClosed).toHaveBeenCalledTimes(1);
});

test('buildApp exposes broadcastBoard', async () => {
  await app.close();
  const built = await buildApp({ config: loadConfig(env), db, now: () => clock, fetch });
  app = built.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  url = `http://127.0.0.1:${addr.port}`;
  const ann = await join({ name: 'Ann' });
  const next = ann.waitFor(() => true);
  await built.realtime.broadcastBoard(boardId);
  expect((await next).id).toBe(boardId);
});

test('concurrent admin:close events call onClosed exactly once', async () => {
  const admin = await join({ name: 'Boss', adminToken });
  const tab2 = await join({ name: 'Boss', participantId: 'boss-tab-2', adminToken });
  const called = new Promise<void>((r) => onClosed.mockImplementation(() => r()));
  const acks = await Promise.all([emit(admin, 'admin:close', {}), emit(tab2, 'admin:close', {}), emit(admin, 'admin:close', {})]);
  expect(acks.filter((a) => a.ok)).toHaveLength(1);
  expect(acks.filter((a) => !a.ok).map(errorOf)).toEqual(['board_closed', 'board_closed']);
  // Failed closes ack without running the post-close hook, so after `called` no further call can arrive.
  await called;
  expect(onClosed).toHaveBeenCalledTimes(1);
});
