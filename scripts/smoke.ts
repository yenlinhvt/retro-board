import { io, type Socket } from 'socket.io-client';
import type { Ack, BoardSnapshot, JoinAuth } from '../src/shared/types';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const INVITE_CODE = process.env.INVITE_CODE;
if (!INVITE_CODE) {
  console.error('INVITE_CODE is required');
  process.exit(2);
}

type Client = { socket: Socket; latest: () => BoardSnapshot | null; waitFor: (p: (s: BoardSnapshot) => boolean, label: string) => Promise<BoardSnapshot> };

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

function connect(auth: JoinAuth): Promise<Client> {
  const socket = io(BASE_URL, { auth, transports: ['websocket'], reconnection: false });
  let latest: BoardSnapshot | null = null;
  const listeners = new Set<() => void>();
  socket.on('board:state', (s: BoardSnapshot) => {
    latest = s;
    listeners.forEach((l) => l());
  });
  const client: Client = {
    socket,
    latest: () => latest,
    waitFor: (pred, label) =>
      new Promise((resolve, reject) => {
        const test = (): void => {
          if (latest && pred(latest)) {
            clearTimeout(timer);
            listeners.delete(test);
            resolve(latest);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(test);
          reject(new Error(`timed out waiting for ${label}`));
        }, 5000);
        listeners.add(test);
        test();
      }),
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timed out')), 5000);
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${e.message}`));
    });
    socket.on('connect', () => {
      clearTimeout(timer);
      client.waitFor(() => true, 'first state').then(() => resolve(client), reject);
    });
  });
}

function emit(c: Client, event: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 5000);
    c.socket.emit(event, payload, (a: Ack) => {
      clearTimeout(timer);
      a.ok ? resolve() : reject(new Error(`${event} failed: ${a.error} ${a.message}`));
    });
  });
}

async function main(): Promise<void> {
  let boardId = '';
  let adminToken = '';
  let admin!: Client;
  let guest!: Client;

  await check('GET /healthz', async () => {
    const r = await fetch(`${BASE_URL}/healthz`);
    assert(r.status === 200, `status ${r.status}`);
  });

  await check('GET / returns HTML', async () => {
    const r = await fetch(`${BASE_URL}/`);
    const body = await r.text();
    assert(r.status === 200, `status ${r.status}`);
    assert((r.headers.get('content-type') ?? '').includes('text/html'), 'not text/html');
    assert(/<html|<!doctype html/i.test(body), 'no html in body');
  });

  await check('POST /api/boards creates a board', async () => {
    const r = await fetch(`${BASE_URL}/api/boards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Smoke ${new Date().toISOString()}`, inviteCode: INVITE_CODE }),
    });
    assert(r.status === 201, `status ${r.status}`);
    const j = (await r.json()) as { boardId: string; adminToken: string };
    assert(j.boardId && j.adminToken, 'missing boardId/adminToken');
    boardId = j.boardId;
    adminToken = j.adminToken;
    console.log(`  board id: ${boardId}`);
  });

  if (!boardId) {
    console.log('cannot continue without a board');
    process.exit(1);
  }

  await check('two socket clients connect (one admin)', async () => {
    admin = await connect({ boardId, participantId: 'smoke-admin', name: 'Admin', adminToken });
    guest = await connect({ boardId, participantId: 'smoke-guest', name: 'Guest' });
    assert(admin.latest()?.isAdmin === true, 'admin not recognised');
    assert(guest.latest()?.isAdmin === false, 'guest should not be admin');
  });

  if (!admin || !guest) {
    console.log('cannot continue without sockets');
    process.exit(1);
  }

  let noteId = '';
  await check('private note is hidden from the other participant', async () => {
    await emit(admin, 'note:add', { columnIndex: 0, text: 'smoke note' });
    const s = await admin.waitFor((x) => x.notes.length === 1, 'admin sees own note');
    noteId = s.notes[0]!.id;
    await new Promise((r) => setTimeout(r, 300));
    assert(guest.latest()!.notes.length === 0, 'guest can see a private note');
  });

  await check('shared note becomes visible to the other participant', async () => {
    await emit(admin, 'note:share', { noteId });
    const s = await guest.waitFor((x) => x.notes.some((n) => n.id === noteId), 'guest sees shared note');
    assert(s.notes[0]!.text === 'smoke note', 'wrong note text');
  });

  await check('vote is counted', async () => {
    await emit(guest, 'vote:add', { noteId });
    await admin.waitFor((x) => x.notes.find((n) => n.id === noteId)?.votes === 1, 'vote count 1');
  });

  await check('timer starts', async () => {
    await emit(admin, 'admin:timer', { type: 'start', durationMs: 60_000 });
    await guest.waitFor((x) => x.timer.status === 'running', 'timer running');
  });

  await check('closing the board reaches both clients', async () => {
    await emit(admin, 'admin:close', {});
    await admin.waitFor((x) => x.status === 'closed', 'admin sees closed');
    await guest.waitFor((x) => x.status === 'closed', 'guest sees closed');
  });

  admin.socket.close();
  guest.socket.close();
  console.log(`\nSmoke board: ${BASE_URL}/b/${boardId}`);
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('All checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
