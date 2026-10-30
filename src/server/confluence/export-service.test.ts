import { beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { addActionItem } from '../actions/action-item-service';
import { closeBoard, getBoard } from '../boards/board-service';
import { loadConfig } from '../config';
import type { Db } from '../db/client';
import { boards } from '../db/schema';
import { addNote, shareNote } from '../notes/note-service';
import { createTestDb, fakeConfluence, seedBoard, seedConnection, seedParticipant } from '../test/helpers';
import { addVote } from '../votes/vote-service';
import { collectExportData, exportBoard, type ExportDeps } from './export-service';

const env = {
  DATABASE_URL: 'postgres://x',
  PUBLIC_BASE_URL: 'https://retro.example.com',
  OWNER_SECRET: 'owner-secret-1234567',
  INVITE_CODES: 'alpha',
  SESSION_SECRET: 's'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};
const config = loadConfig(env);
const clock = Date.UTC(2026, 9, 30, 9);
const TITLE = 'Retro – S – 2026-10-30';

let db: Db;
let boardId: string;
let confluence: ReturnType<typeof fakeConfluence>;
let deps: ExportDeps;
let notify: ReturnType<typeof vi.fn>;

async function publicNote(authorId: string, col: number, text: string) {
  const n = await addNote(db, boardId, authorId, col, text);
  await shareNote(db, boardId, authorId, n.id);
  return n;
}

beforeEach(async () => {
  db = await createTestDb();
  ({ boardId } = await seedBoard(db, { name: 'S' }));
  await db.update(boards).set({ confluenceSpaceId: '100', confluenceSpaceName: 'Engineering' }).where(eq(boards.id, boardId));
  await seedConnection(db, config.encryptionKey, clock);
  confluence = fakeConfluence();
  notify = vi.fn(async () => {});
  deps = { config, db, now: () => clock, fetch: confluence.fetch, notify };
});

const board = () => getBoard(db, boardId);
const onlyPage = () => [...confluence.pages.values()][0]!;

test('collectExportData: public notes only, sorted, participants and action items', async () => {
  const ann = await seedParticipant(db, boardId, 'ann');
  const bob = await seedParticipant(db, boardId, 'Bob');
  const cid = await seedParticipant(db, boardId, 'Cid');
  await seedParticipant(db, boardId, 'Lurker');
  const first = await publicNote(ann.id, 0, 'first');
  const second = await publicNote(ann.id, 0, 'second');
  await addNote(db, boardId, bob.id, 0, 'private text');
  await addVote(db, boardId, cid.id, second.id);
  await addActionItem(db, boardId, bob.id, { text: 'Do it', owner: 'Ann', noteId: first.id });
  await addActionItem(db, boardId, bob.id, { text: 'Loose', owner: '', noteId: null });

  const d = await collectExportData(db, boardId, clock);
  expect(d.boardName).toBe('S');
  expect(d.date).toBe('2026-10-30');
  expect(d.participants).toEqual(['ann', 'Bob', 'Cid']);
  expect(d.columns).toHaveLength(4);
  expect(d.columns[0]).toEqual({
    name: 'Went well',
    notes: [
      { text: 'second', author: 'ann', votes: 1 },
      { text: 'first', author: 'ann', votes: 0 },
    ],
  });
  expect(d.actionItems).toEqual([
    { text: 'Do it', owner: 'Ann', noteText: 'first' },
    { text: 'Loose', owner: '', noteText: null },
  ]);
});

test('collectExportData uses closed_at for the date', async () => {
  await closeBoard(db, boardId, new Date(Date.UTC(2026, 0, 2, 23, 30)));
  expect((await collectExportData(db, boardId, clock)).date).toBe('2026-01-02');
});

test('close auto-exports a new page with public notes only', async () => {
  const ann = await seedParticipant(db, boardId, 'Ann');
  await publicNote(ann.id, 0, 'shared text');
  await addNote(db, boardId, ann.id, 1, 'private text');
  await closeBoard(db, boardId, new Date(clock));
  await exportBoard(deps, boardId, 'auto');

  const page = onlyPage();
  expect(page.title).toBe(TITLE);
  expect(page.spaceId).toBe('100');
  expect(page.body).toContain('shared text');
  expect(page.body).not.toContain('private text');
  const b = await board();
  expect(b).toMatchObject({
    exportStatus: 'success',
    exportError: null,
    confluencePageId: page.id,
    confluencePageVersion: 1,
    confluencePageUrl: `https://x.atlassian.net/wiki/spaces/S/pages/${page.id}`,
  });
  expect(notify).toHaveBeenCalledTimes(2); // pending, then outcome
});

test('re-export updates same page with version+1', async () => {
  await exportBoard(deps, boardId, 'auto');
  const ann = await seedParticipant(db, boardId, 'Ann');
  await publicNote(ann.id, 0, 'added later');
  await exportBoard(deps, boardId, 'overwrite');
  expect(confluence.pages.size).toBe(1);
  expect(onlyPage()).toMatchObject({ version: 2 });
  expect(onlyPage().body).toContain('added later');
  expect(await board()).toMatchObject({ exportStatus: 'success', confluencePageVersion: 2 });
  await exportBoard(deps, boardId, 'auto');
  expect(await board()).toMatchObject({ exportStatus: 'success', confluencePageVersion: 3 });
});

test('conflict when page edited externally; overwrite succeeds; new creates second page', async () => {
  await exportBoard(deps, boardId, 'auto');
  onlyPage().version = 5; // someone edited it in Confluence
  await exportBoard(deps, boardId, 'auto');
  expect(await board()).toMatchObject({
    exportStatus: 'conflict',
    exportError: 'The Confluence page was edited after the last export',
    confluencePageVersion: 1,
  });
  expect(onlyPage().version).toBe(5);

  await exportBoard(deps, boardId, 'overwrite');
  expect(await board()).toMatchObject({ exportStatus: 'success', exportError: null, confluencePageVersion: 6 });

  await exportBoard(deps, boardId, 'new');
  expect(confluence.pages.size).toBe(2);
  const second = [...confluence.pages.values()][1]!;
  expect(second.title).toBe(`${TITLE} (2)`);
  expect(await board()).toMatchObject({ exportStatus: 'success', confluencePageId: second.id, confluencePageVersion: 1 });
});

test('deleted page is recreated', async () => {
  await exportBoard(deps, boardId, 'auto');
  const firstId = onlyPage().id;
  confluence.pages.clear();
  await exportBoard(deps, boardId, 'auto');
  expect(onlyPage().id).not.toBe(firstId);
  expect(await board()).toMatchObject({ exportStatus: 'success', confluencePageId: onlyPage().id, confluencePageVersion: 1 });
});

test('create retries with suffix on title conflict', async () => {
  confluence.pages.set('x', { id: 'x', spaceId: '100', parentId: null, title: TITLE, version: 1, body: '' });
  await exportBoard(deps, boardId, 'auto');
  const created = [...confluence.pages.values()].find((p) => p.id !== 'x')!;
  expect(created.title).toBe('Retro – S – 2026-10-30 (2)');
  expect((await board()).exportStatus).toBe('success');
});

test('gives up after suffix (10)', async () => {
  for (const t of [TITLE, ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `${TITLE} (${i})`)]) {
    confluence.pages.set(t, { id: t, spaceId: '100', parentId: null, title: t, version: 1, body: '' });
  }
  await exportBoard(deps, boardId, 'auto');
  expect(await board()).toMatchObject({ exportStatus: 'failed', exportError: 'Export failed: a page with this title already exists' });
});

test('403 maps to no-permission message; data intact', async () => {
  await exportBoard(deps, boardId, 'auto');
  const before = await board();
  confluence.state.failWith = 403;
  await exportBoard(deps, boardId, 'overwrite');
  const after = await board();
  expect(after).toMatchObject({
    exportStatus: 'failed',
    exportError: 'No permission to create pages in this Confluence space',
    confluencePageId: before.confluencePageId,
    confluencePageVersion: before.confluencePageVersion,
    confluencePageUrl: before.confluencePageUrl,
  });
});

test('error mapping: 401 reconnect, missing parent, other status', async () => {
  confluence.state.failWith = 401;
  await exportBoard(deps, boardId, 'new');
  expect((await board()).exportError).toBe('Atlassian connection expired — owner needs to reconnect in Settings');

  confluence.state.failWith = null;
  await db.update(boards).set({ confluenceParentId: 'gone' }).where(eq(boards.id, boardId));
  await exportBoard(deps, boardId, 'new');
  expect((await board()).exportError).toBe('Parent page not found — pick another');

  const log = { error: vi.fn() };
  confluence.state.failWith = 500;
  await exportBoard({ ...deps, log }, boardId, 'new');
  expect(await board()).toMatchObject({ exportStatus: 'failed', exportError: 'Export failed: 500' });
  expect(log.error).toHaveBeenCalled();
});

test('auto mode with no connection does nothing', async () => {
  const fresh = await createTestDb();
  const { boardId: id } = await seedBoard(fresh);
  await exportBoard({ ...deps, db: fresh }, id, 'auto');
  expect((await getBoard(fresh, id)).exportStatus).toBe('idle');
  expect(notify).not.toHaveBeenCalled();
  expect(confluence.state.calls).toEqual([]);

  await exportBoard({ ...deps, db: fresh }, id, 'overwrite');
  expect(await getBoard(fresh, id)).toMatchObject({
    exportStatus: 'failed',
    exportError: 'Confluence is not connected — the owner can connect it in Settings',
  });
  expect(notify).toHaveBeenCalledWith(id);
});

test('no space chosen fails with a hint', async () => {
  await db.update(boards).set({ confluenceSpaceId: null, confluenceSpaceName: null }).where(eq(boards.id, boardId));
  await exportBoard(deps, boardId, 'auto');
  expect(await board()).toMatchObject({ exportStatus: 'failed', exportError: 'Choose a Confluence space for this board first' });
  expect(confluence.state.calls).toEqual([]);
});

test('a second export while one is running returns immediately', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowFetch = (async (input: string, init?: RequestInit) => {
    await gate;
    return confluence.fetch(input, init);
  }) as typeof fetch;
  const first = exportBoard({ ...deps, fetch: slowFetch }, boardId, 'auto');
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  await exportBoard(deps, boardId, 'new');
  expect(confluence.state.calls).toEqual([]);
  release();
  await first;
  expect(confluence.pages.size).toBe(1);
  await exportBoard(deps, boardId, 'new'); // guard released
  expect(confluence.pages.size).toBe(2);
});

test('never throws: unexpected errors become an internal failure', async () => {
  const log = { error: vi.fn() };
  const boom = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  await expect(exportBoard({ ...deps, fetch: boom, log }, boardId, 'auto')).resolves.toBeUndefined();
  expect(await board()).toMatchObject({ exportStatus: 'failed', exportError: 'Export failed: internal error' });
  expect(log.error).toHaveBeenCalled();
});
