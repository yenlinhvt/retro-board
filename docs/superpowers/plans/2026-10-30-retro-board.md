# Retro Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted, real-time retrospective board (private→public notes, voting, timer, action items, admin link, invite-only creation) that exports to Confluence Cloud on close, packaged as a Docker image + compose stack.

**Architecture:** A single TypeScript repo. A Fastify server owns all state in Postgres (Drizzle ORM) and exposes a small HTTP API (board creation, owner settings, Atlassian OAuth, Confluence pickers/export) plus a Socket.IO channel per board. Clients send *intents* over Socket.IO; after every mutation the server rebuilds and pushes a **per-viewer snapshot** to each socket in the room, so private notes are filtered on the server and reconnects are a full resync. The React (Vite) client renders snapshots only.

**Tech Stack:** Node 22, TypeScript 5, Fastify 5, Socket.IO 4, Postgres 16, Drizzle ORM + drizzle-kit, PGlite (tests only), Zod, React 18, react-router-dom 6, Vite 5, Vitest, @testing-library/react, tsup, Docker + Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-30-retro-board-design.md`

## Global Constraints

- Exactly 4 columns; defaults `["Went well", "To improve", "Ideas", "Shout-outs"]`.
- Note text: plain text, 1–1000 chars after trim. Column name: 1–60 chars. Board name: 1–100 chars. Display name: 1–40 chars. Action item text: 1–500 chars; owner 0–60 chars.
- Default vote limit 5; admin may set 1–50.
- Board ID ≥128 bits random (16 bytes base64url); admin token 32 bytes base64url, stored as SHA-256 hex hash only.
- Private notes never leave the server except to their author's sockets; never in Confluence export.
- Atlassian tokens AES-256-GCM encrypted at rest; never sent to the browser.
- Invite code and owner secret compared with `crypto.timingSafeEqual` (after hashing both sides to equal length).
- Page title format: `Retro – {board name} – {YYYY-MM-DD}` (en dash `–`, date = board `closed_at` or now, UTC).
- Confluence Cloud REST v2 only.
- Env vars (all in `.env.example`): `DATABASE_URL`, `PORT` (default 3000), `PUBLIC_BASE_URL`, `OWNER_SECRET`, `INVITE_CODES`, `SESSION_SECRET`, `ENCRYPTION_KEY` (base64 of 32 bytes), `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` (both optional → Confluence disabled).
- Server is the source of truth; every write checks permission and `board.status === 'open'` (except reopen/delete/export/export-target).
- Done = `docker compose up --build` from a clean checkout serves a working app and `npm run smoke` passes against it.

## Review Focus

1. **Reconnect after laptop sleep / Wi-Fi drop** — client must receive a full fresh snapshot on reconnect and the timer must show the correct remaining time using server clock offset, not local clock. → Task 11 (resync test), Task 8 (`remainingMs` with offset).
2. **Same participant in two tabs** — both tabs must show the participant's private notes and stay in sync; presence counts them once. → Task 11 test `same participant in two tabs receives private notes in both`.
3. **Rapid double-clicks on vote** — concurrent `vote:add` must never exceed the limit. → Task 6 test `concurrent votes never exceed limit`.
4. **Hostile/odd note text** (`<script>`, `&`, `]]>`, emoji, newlines) — rendered as text in UI and escaped in Confluence storage format. → Task 13 render test, Task 16 component test.
5. **Confluence title collision** (same board name same day, or "Create new page") — export must not fail; suffix ` (2)`, ` (3)`… → Task 14 test `create retries with suffix on title conflict`.

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, vitest.config.ts, tsup.config.ts, drizzle.config.ts
.env.example, .gitignore, .dockerignore, Dockerfile, docker-compose.yml, README.md
drizzle/                          generated SQL migrations
scripts/smoke.ts                  end-to-end smoke against a running instance
src/shared/constants.ts           limits, default columns
src/shared/types.ts               snapshot views, socket event contracts, error codes
src/shared/timer.ts               pure timer state machine (used by server + client)
src/server/config.ts              env parsing
src/server/errors.ts              DomainError
src/server/security/tokens.ts     randomId, hashToken, safeEqual
src/server/security/crypto.ts     encrypt/decrypt
src/server/db/schema.ts           Drizzle tables
src/server/db/client.ts           Db type, createDb, migrateDb
src/server/test/helpers.ts        createTestDb (PGlite), seed helpers
src/server/boards/board-service.ts
src/server/boards/participant-service.ts
src/server/notes/note-service.ts
src/server/votes/vote-service.ts
src/server/actions/action-item-service.ts
src/server/timer/timer-service.ts
src/server/realtime/snapshot.ts   buildSnapshot (per-viewer filtering)
src/server/realtime/presence.ts   in-memory online tracking
src/server/realtime/rate-limit.ts token bucket
src/server/realtime/socket.ts     Socket.IO wiring
src/server/http/app.ts            buildApp (Fastify), static, healthz
src/server/http/board-routes.ts   POST /api/boards, Confluence board routes
src/server/http/settings-routes.ts owner session + OAuth routes
src/server/confluence/connection-store.ts
src/server/confluence/oauth.ts
src/server/confluence/confluence-client.ts
src/server/confluence/render.ts
src/server/confluence/export-service.ts
src/server/index.ts               main: config → migrate → listen
src/client/main.tsx, App.tsx, styles.css
src/client/lib/identity.ts        localStorage identity
src/client/lib/useBoard.ts        socket + snapshot hook
src/client/pages/HomePage.tsx
src/client/pages/BoardPage.tsx
src/client/pages/SettingsPage.tsx
src/client/components/JoinPrompt.tsx, Column.tsx, NoteCard.tsx, TimerBar.tsx,
                      Presence.tsx, ActionItems.tsx, AdminPanel.tsx, ExportPanel.tsx
```

Tests live next to the code as `*.test.ts(x)`.

---

### Task 1: Project scaffold, shared contracts, timer logic

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `tsup.config.ts`, `.gitignore`, `src/shared/constants.ts`, `src/shared/types.ts`, `src/shared/timer.ts`
- Test: `src/shared/timer.test.ts`

**Interfaces:**
- Produces (`src/shared/constants.ts`): `DEFAULT_COLUMNS: readonly [string,string,string,string]`, `COLUMN_COUNT = 4`, `LIMITS = { noteText: 1000, columnName: 60, boardName: 100, displayName: 40, actionText: 500, actionOwner: 60, voteLimitMin: 1, voteLimitMax: 50 }`, `DEFAULT_VOTE_LIMIT = 5`.
- Produces (`src/shared/types.ts`):
  ```ts
  export type ErrorCode = 'not_found'|'forbidden'|'board_closed'|'vote_limit_reached'|'invalid_input'|'rate_limited'|'internal';
  export type Ack = { ok: true } | { ok: false; error: ErrorCode; message: string };
  export type TimerState = { status: 'idle'|'running'|'paused'; durationMs: number; endsAt: number|null; remainingMs: number }; // endsAt = epoch ms
  export type TimerAction = { type: 'start'; durationMs: number } | { type: 'pause' } | { type: 'resume' } | { type: 'reset' } | { type: 'addMinute' };
  export type NoteView = { id: string; columnIndex: number; text: string; authorPublicId: string; authorName: string; isPublic: boolean; isMine: boolean; votes: number; myVotes: number; createdAt: string; sharedAt: string|null };
  export type ParticipantView = { publicId: string; name: string; online: boolean; isMe: boolean };
  export type ActionItemView = { id: string; text: string; owner: string; noteId: string|null; canEdit: boolean; createdAt: string };
  export type ExportStatus = 'not_connected'|'idle'|'pending'|'success'|'conflict'|'failed';
  export type ExportView = { status: ExportStatus; pageUrl: string|null; error: string|null; spaceId: string|null; spaceName: string|null; parentId: string|null; parentTitle: string|null };
  export type BoardSnapshot = { id: string; name: string; status: 'open'|'closed'; columns: string[]; voteLimit: number; votesRemaining: number; notes: NoteView[]; participants: ParticipantView[]; actionItems: ActionItemView[]; timer: TimerState; isAdmin: boolean; export: ExportView|null /* admin only */; serverNow: number };
  export type JoinAuth = { boardId: string; participantId: string; name: string; adminToken?: string };
  export interface ClientToServer {
    'note:add'(p: { columnIndex: number; text: string }, ack: (a: Ack) => void): void;
    'note:edit'(p: { noteId: string; text: string }, ack: (a: Ack) => void): void;
    'note:delete'(p: { noteId: string }, ack: (a: Ack) => void): void;
    'note:share'(p: { noteId: string }, ack: (a: Ack) => void): void;
    'vote:add'(p: { noteId: string }, ack: (a: Ack) => void): void;
    'vote:remove'(p: { noteId: string }, ack: (a: Ack) => void): void;
    'action:add'(p: { text: string; owner: string; noteId: string|null }, ack: (a: Ack) => void): void;
    'action:edit'(p: { id: string; text: string; owner: string }, ack: (a: Ack) => void): void;
    'action:delete'(p: { id: string }, ack: (a: Ack) => void): void;
    'participant:rename'(p: { name: string }, ack: (a: Ack) => void): void;
    'admin:renameColumn'(p: { columnIndex: number; name: string }, ack: (a: Ack) => void): void;
    'admin:setVoteLimit'(p: { limit: number }, ack: (a: Ack) => void): void;
    'admin:timer'(p: TimerAction, ack: (a: Ack) => void): void;
    'admin:close'(p: {}, ack: (a: Ack) => void): void;
    'admin:reopen'(p: {}, ack: (a: Ack) => void): void;
    'admin:delete'(p: {}, ack: (a: Ack) => void): void;
  }
  export interface ServerToClient { 'board:state'(s: BoardSnapshot): void; 'board:deleted'(): void; }
  ```
- Produces (`src/shared/timer.ts`): `applyTimerAction(state: TimerState, action: TimerAction, now: number): TimerState`, `remainingMs(state: TimerState, now: number): number` (clamped ≥0), `IDLE_TIMER: TimerState`.

- [ ] **Step 1: Init repo and tooling**

Run `git init`. Create `package.json` (`"type": "module"`, `"engines": {"node": ">=22"}`) with scripts:
`dev` (concurrently `tsx watch src/server/index.ts` + `vite`), `build` (`vite build && tsup`), `start` (`node dist/server/index.js`), `test` (`vitest run`), `typecheck` (`tsc --noEmit`), `db:generate` (`drizzle-kit generate`), `smoke` (`tsx scripts/smoke.ts`).
Install deps listed in Tech Stack plus `zod`, `pg`, `@fastify/static`, `@fastify/cookie`, `@fastify/rate-limit`, `socket.io-client`, `tsx`, `concurrently`, `@electric-sql/pglite`, `jsdom`, `@vitejs/plugin-react`.
`vite.config.ts`: root `src/client`, outDir `../../dist/client`, dev proxy `/api` and `/socket.io` (ws) → `http://localhost:3000`.
`tsup.config.ts`: entry `src/server/index.ts`, format esm, target node22, outDir `dist/server`.
`vitest.config.ts`: `environment: 'node'`, `environmentMatchGlobs: [['src/client/**', 'jsdom']]`.
`.gitignore`: `node_modules`, `dist`, `.env`.

- [ ] **Step 2: Write the failing timer tests** in `src/shared/timer.test.ts`

```ts
const T0 = 1_000_000;
test('start sets running with endsAt = now + duration', () => {
  const s = applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 300_000 }, T0);
  expect(s).toEqual({ status: 'running', durationMs: 300_000, endsAt: T0 + 300_000, remainingMs: 300_000 });
});
test('pause freezes remaining, resume continues from it', () => {
  let s = applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 60_000 }, T0);
  s = applyTimerAction(s, { type: 'pause' }, T0 + 20_000);
  expect(s.status).toBe('paused'); expect(s.remainingMs).toBe(40_000); expect(s.endsAt).toBeNull();
  s = applyTimerAction(s, { type: 'resume' }, T0 + 100_000);
  expect(s.endsAt).toBe(T0 + 140_000);
});
test('addMinute extends running and paused timers, and starts a 60s timer when idle', () => {
  const r = applyTimerAction(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 10_000 }, T0), { type: 'addMinute' }, T0);
  expect(r.endsAt).toBe(T0 + 70_000);
  const i = applyTimerAction(IDLE_TIMER, { type: 'addMinute' }, T0);
  expect(i).toMatchObject({ status: 'running', endsAt: T0 + 60_000 });
});
test('reset returns to idle keeping durationMs', () => {
  const s = applyTimerAction(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 5_000 }, T0), { type: 'reset' }, T0 + 1);
  expect(s).toEqual({ status: 'idle', durationMs: 5_000, endsAt: null, remainingMs: 5_000 });
});
test('remainingMs clamps to 0 after expiry and works for paused', () => {
  const s = applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 1_000 }, T0);
  expect(remainingMs(s, T0 + 400)).toBe(600);
  expect(remainingMs(s, T0 + 5_000)).toBe(0);
});
test('pause/resume on wrong state is a no-op', () => {
  expect(applyTimerAction(IDLE_TIMER, { type: 'pause' }, T0)).toEqual(IDLE_TIMER);
});
```

- [ ] **Step 3: Run** `npx vitest run src/shared/timer.test.ts` → FAIL (module not found).
- [ ] **Step 4: Implement** `constants.ts`, `types.ts` (exactly as in Interfaces), `timer.ts`. `IDLE_TIMER = { status: 'idle', durationMs: 300_000, endsAt: null, remainingMs: 300_000 }`. `start` rejects (`no-op`) durations outside 10s–3h.
- [ ] **Step 5: Run** `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `git add -A && git commit -m "chore: scaffold project with shared contracts and timer logic"`

---

### Task 2: Config, errors, security utilities

**Files:**
- Create: `src/server/config.ts`, `src/server/errors.ts`, `src/server/security/tokens.ts`, `src/server/security/crypto.ts`, `.env.example`
- Test: `src/server/config.test.ts`, `src/server/security/security.test.ts`

**Interfaces:**
- Produces: `type Config = { databaseUrl: string; port: number; publicBaseUrl: string; ownerSecret: string; inviteCodes: string[]; sessionSecret: string; encryptionKey: Buffer; atlassian: { clientId: string; clientSecret: string } | null }`; `loadConfig(env: NodeJS.ProcessEnv): Config` (throws listing every missing/invalid var).
- Produces: `class DomainError extends Error { constructor(public code: ErrorCode, message: string) }`.
- Produces: `randomId(bytes: number): string` (base64url), `hashToken(token: string): string` (sha256 hex), `safeEqual(a: string, b: string): boolean`, `matchesAny(candidate: string, allowed: string[]): boolean` (constant-time per entry, checks all).
- Produces: `encrypt(plain: string, key: Buffer): string` (`iv.tag.ciphertext` base64url, AES-256-GCM), `decrypt(blob: string, key: Buffer): string` (throws on tamper).

- [ ] **Step 1: Write failing tests**

```ts
// config.test.ts
const base = { DATABASE_URL: 'postgres://x', PUBLIC_BASE_URL: 'https://retro.example.com', OWNER_SECRET: 'o'.repeat(16), INVITE_CODES: 'alpha, beta ,', SESSION_SECRET: 's'.repeat(32), ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
test('parses invite codes, trims, drops empties; port defaults 3000; atlassian null when unset', () => {
  const c = loadConfig(base);
  expect(c.inviteCodes).toEqual(['alpha', 'beta']); expect(c.port).toBe(3000); expect(c.atlassian).toBeNull();
});
test('rejects ENCRYPTION_KEY that is not 32 bytes', () => {
  expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
});
test('rejects OWNER_SECRET shorter than 16 chars and empty INVITE_CODES', () => {
  expect(() => loadConfig({ ...base, OWNER_SECRET: 'x', INVITE_CODES: '' })).toThrow(/OWNER_SECRET[\s\S]*INVITE_CODES|INVITE_CODES[\s\S]*OWNER_SECRET/);
});
// security.test.ts
test('randomId(16) is 22 url-safe chars and unique', () => { const a = randomId(16); expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(randomId(16)).not.toBe(a); });
test('encrypt/decrypt round-trips and detects tampering', () => {
  const key = Buffer.alloc(32, 7); const blob = encrypt('secret-token', key);
  expect(decrypt(blob, key)).toBe('secret-token');
  expect(() => decrypt(blob.slice(0, -2) + 'AA', key)).toThrow();
});
test('matchesAny', () => { expect(matchesAny('beta', ['alpha','beta'])).toBe(true); expect(matchesAny('bet', ['alpha','beta'])).toBe(false); });
```

- [ ] **Step 2: Run** `npx vitest run src/server` → FAIL.
- [ ] **Step 3: Implement** with Zod for config. `safeEqual` hashes both inputs with sha256 then `timingSafeEqual`. Write `.env.example` with every var from Global Constraints, a comment per var, and `openssl rand -base64 32` hints.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add config loading and security utilities`

---

### Task 3: Database schema, migrations, test DB

**Files:**
- Create: `drizzle.config.ts`, `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/test/helpers.ts`, `drizzle/*` (generated)
- Test: `src/server/db/schema.test.ts`

**Interfaces:**
- Produces tables (snake_case columns, all ids `text` unless noted):
  - `boards`: `id` pk, `name`, `admin_token_hash`, `status` ('open'|'closed', default 'open'), `columns` jsonb `string[]`, `vote_limit` int default 5, `timer` jsonb `TimerState` default `IDLE_TIMER`, `confluence_space_id`, `confluence_space_name`, `confluence_parent_id`, `confluence_parent_title`, `confluence_page_id`, `confluence_page_version` int, `confluence_page_url`, `export_status` default 'idle', `export_error`, `created_at` timestamptz default now, `closed_at` timestamptz null.
  - `participants`: `id` pk (server uuid), `board_id` fk→boards cascade, `client_id` (secret from browser), `public_id` (randomId(8)), `name`, `created_at`; unique(`board_id`,`client_id`).
  - `notes`: `id` pk, `board_id` fk cascade, `author_id` fk→participants cascade, `column_index` int, `text`, `is_public` bool default false, `created_at`, `shared_at` null, `updated_at`; index(`board_id`).
  - `votes`: `id` pk, `board_id` fk cascade, `note_id` fk→notes cascade, `participant_id` fk→participants cascade, `created_at`; index(`board_id`,`participant_id`).
  - `action_items`: `id` pk, `board_id` fk cascade, `text`, `owner`, `note_id` fk→notes **set null**, `created_by` fk→participants cascade, `created_at`.
  - `atlassian_connection`: `id` int pk (always 1), `cloud_id`, `site_url`, `site_name`, `access_token_enc`, `refresh_token_enc`, `expires_at` timestamptz, `default_space_id`, `default_space_name`, `default_parent_id`, `default_parent_title`, `updated_at`. (`cloud_id`/site columns nullable until site chosen.)
- Produces (`client.ts`): `type Db = PgDatabase<PgQueryResultHKT, typeof schema>`; `createDb(url: string): { db: Db; close(): Promise<void> }` (node-postgres pool); `migrateDb(db: Db): Promise<void>` (runs `drizzle/` folder).
- Produces (`helpers.ts`): `createTestDb(): Promise<Db>` (fresh in-memory PGlite + migrations), `seedBoard(db: Db, opts?: { name?: string }): Promise<{ boardId: string; adminToken: string }>` (implemented in Task 4 once `createBoard` exists — stub it there), `seedParticipant(db: Db, boardId: string, name: string): Promise<Participant>`.

- [ ] **Step 1: Write failing test**

```ts
test('migrations apply and cascade delete removes children', async () => {
  const db = await createTestDb();
  await db.insert(boards).values({ id: 'b1', name: 'B', adminTokenHash: 'h', columns: ['a','b','c','d'] });
  await db.insert(participants).values({ id: 'p1', boardId: 'b1', clientId: 'c1', publicId: 'pub1', name: 'Ann' });
  await db.insert(notes).values({ id: 'n1', boardId: 'b1', authorId: 'p1', columnIndex: 0, text: 'hi' });
  await db.delete(boards).where(eq(boards.id, 'b1'));
  expect(await db.select().from(notes)).toHaveLength(0);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement schema + client**, then run `npm run db:generate` to create `drizzle/0000_*.sql`. `createTestDb` uses `drizzle-orm/pglite` and `drizzle-orm/pglite/migrator` against the same `drizzle/` folder.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add database schema and migrations`

---

### Task 4: Board and participant services

**Files:**
- Create: `src/server/boards/board-service.ts`, `src/server/boards/participant-service.ts`
- Modify: `src/server/test/helpers.ts` (implement `seedBoard`)
- Test: `src/server/boards/board-service.test.ts`

**Interfaces:**
- Consumes: `Db`, tables, `randomId`, `hashToken`, `safeEqual`, `DomainError`, `LIMITS`, `DEFAULT_COLUMNS`.
- Produces:
  - `type Board = typeof boards.$inferSelect`; `type Participant = typeof participants.$inferSelect`.
  - `createBoard(db: Db, input: { name: string; defaults?: { spaceId; spaceName; parentId; parentTitle } | null }): Promise<{ board: Board; adminToken: string }>` — trims/validates name, default columns, copies Confluence defaults into board, `export_status` = 'idle'.
  - `getBoard(db, boardId): Promise<Board>` (throws `not_found`).
  - `verifyAdmin(board: Board, adminToken: string|undefined): boolean`.
  - `assertOpen(board: Board): void` (throws `board_closed`).
  - `renameColumn(db, boardId, columnIndex: number, name: string): Promise<void>`
  - `setVoteLimit(db, boardId, limit: number): Promise<void>`
  - `closeBoard(db, boardId, now: Date)`, `reopenBoard(db, boardId)`, `deleteBoard(db, boardId)`.
  - `upsertParticipant(db, boardId, clientId: string, name: string): Promise<Participant>` — validates name, updates name if existing.
  - `renameParticipant(db, participantId, name)`.

- [ ] **Step 1: Write failing tests**

```ts
test('createBoard returns admin token whose hash is stored, with 4 default columns', async () => {
  const { board, adminToken } = await createBoard(db, { name: ' Sprint 42 ' });
  expect(board.name).toBe('Sprint 42'); expect(board.columns).toEqual([...DEFAULT_COLUMNS]);
  expect(board.id).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(board.adminTokenHash).toBe(hashToken(adminToken));
  expect(verifyAdmin(board, adminToken)).toBe(true); expect(verifyAdmin(board, 'nope')).toBe(false); expect(verifyAdmin(board, undefined)).toBe(false);
});
test('renameColumn validates index and length', async () => {
  await expect(renameColumn(db, id, 4, 'x')).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(renameColumn(db, id, 0, '  ')).rejects.toMatchObject({ code: 'invalid_input' });
  await renameColumn(db, id, 2, 'Puzzles'); expect((await getBoard(db, id)).columns[2]).toBe('Puzzles');
});
test('setVoteLimit enforces 1..50', ...);           // 0 and 51 reject invalid_input; 7 persists
test('close sets closed_at; reopen clears; delete removes', ...);
test('upsertParticipant is idempotent per clientId and updates name', async () => {
  const a = await upsertParticipant(db, id, 'client-1', 'Ann'); const b = await upsertParticipant(db, id, 'client-1', 'Annie');
  expect(b.id).toBe(a.id); expect(b.publicId).toBe(a.publicId); expect(b.name).toBe('Annie');
});
test('createBoard copies Confluence defaults', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add board and participant services`

---

### Task 5: Note service

**Files:**
- Create: `src/server/notes/note-service.ts`
- Test: `src/server/notes/note-service.test.ts`

**Interfaces:**
- Consumes: `getBoard`, `assertOpen`, `Participant`.
- Produces (every function loads the board and calls `assertOpen`):
  - `addNote(db, boardId, authorId, columnIndex: number, text: string): Promise<Note>`
  - `editNote(db, boardId, actorId, noteId, text): Promise<void>` — author only.
  - `shareNote(db, boardId, actorId, noteId): Promise<void>` — author only; sets `is_public`, `shared_at`; sharing an already-public note is a no-op.
  - `deleteNote(db, boardId, actor: { participantId: string; isAdmin: boolean }, noteId): Promise<void>` — author always; admin only if note is public (admin must not delete — or even learn about — other people's private notes: return `not_found`).

- [ ] **Step 1: Write failing tests**

```ts
test('add trims text and rejects empty / >1000 chars / bad column', ...);
test('only author can edit or share', async () => {
  const n = await addNote(db, b, ann.id, 0, 'hello');
  await expect(editNote(db, b, bob.id, n.id, 'x')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(shareNote(db, b, bob.id, n.id)).rejects.toMatchObject({ code: 'forbidden' });
  await shareNote(db, b, ann.id, n.id);
  expect((await getNote(n.id)).isPublic).toBe(true);
});
test('admin can delete public notes but gets not_found for others\' private notes', ...);
test('author can edit a public note', ...);
test('all writes reject with board_closed after close', ...);
test('note id from another board is not_found', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add note service`.

---

### Task 6: Vote service

**Files:**
- Create: `src/server/votes/vote-service.ts`
- Test: `src/server/votes/vote-service.test.ts`

**Interfaces:**
- Produces:
  - `addVote(db, boardId, participantId, noteId): Promise<void>` — note must be public and on the board; inside a transaction, take `SELECT ... FOR UPDATE` on the participant row, count the participant's votes on the board, reject `vote_limit_reached` at `vote_limit`, else insert.
  - `removeVote(db, boardId, participantId, noteId): Promise<void>` — deletes one of the participant's votes on that note; no-op if none.
  - Lowering `vote_limit` below votes already cast keeps existing votes; `votesRemaining` floors at 0 (Task 9).

- [ ] **Step 1: Write failing tests**

```ts
test('can stack multiple votes on one note up to the limit', async () => {
  await setVoteLimit(db, b, 3);
  for (let i = 0; i < 3; i++) await addVote(db, b, ann.id, pub.id);
  await expect(addVote(db, b, ann.id, pub.id)).rejects.toMatchObject({ code: 'vote_limit_reached' });
});
test('cannot vote on private note', ...);                 // → not_found (do not reveal existence)
test('removeVote removes exactly one of my votes', ...);
test('concurrent votes never exceed limit', async () => {
  await setVoteLimit(db, b, 5);
  await Promise.allSettled(Array.from({ length: 20 }, () => addVote(db, b, ann.id, pub.id)));
  expect(await countVotes(ann.id)).toBe(5);
});
test('rejects when board closed', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add vote service with enforced limit`.

---

### Task 7: Action item service

**Files:**
- Create: `src/server/actions/action-item-service.ts`
- Test: `src/server/actions/action-item-service.test.ts`

**Interfaces:**
- Produces:
  - `addActionItem(db, boardId, creatorId, input: { text: string; owner: string; noteId: string|null }): Promise<ActionItem>` — `noteId`, if given, must be a **public** note on the board (else `invalid_input`).
  - `editActionItem(db, boardId, actor: { participantId; isAdmin }, id, input: { text; owner }): Promise<void>` — creator or admin.
  - `deleteActionItem(db, boardId, actor, id): Promise<void>` — creator or admin.
- All assert open board.

- [ ] **Step 1: Failing tests:** add validates lengths (text 1–500, owner 0–60); link to private note → `invalid_input`; non-creator non-admin edit/delete → `forbidden`; admin can edit/delete anyone's; deleting the linked note sets `noteId` null (FK); closed board rejects.
- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add action item service`.

---

### Task 8: Timer service and client clock offset

**Files:**
- Create: `src/server/timer/timer-service.ts`
- Modify: `src/shared/timer.ts` (add `clientRemainingMs`)
- Test: `src/server/timer/timer-service.test.ts`, `src/shared/timer.test.ts`

**Interfaces:**
- Consumes: `applyTimerAction`.
- Produces: `applyTimer(db, boardId, action: TimerAction, now: number): Promise<TimerState>` (asserts open, persists `boards.timer`).
- Produces (shared): `clientRemainingMs(state: TimerState, serverNow: number, receivedAtLocal: number, localNow: number): number` = `remainingMs(state, serverNow + (localNow - receivedAtLocal))`.

- [ ] **Step 1: Failing tests**

```ts
test('timer persists across reads', async () => {
  await applyTimer(db, b, { type: 'start', durationMs: 60_000 }, 1_000);
  expect((await getBoard(db, b)).timer).toMatchObject({ status: 'running', endsAt: 61_000 });
});
test('clientRemainingMs ignores a skewed local clock', () => {
  const s = applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 60_000 }, 1_000_000);
  // local clock is 5 minutes ahead; snapshot received 10s after server start
  expect(clientRemainingMs(s, 1_010_000, 1_310_000, 1_315_000)).toBe(45_000);
});
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add server-authoritative timer`.

---

### Task 9: Per-viewer snapshot builder

**Files:**
- Create: `src/server/realtime/snapshot.ts`
- Test: `src/server/realtime/snapshot.test.ts`

**Interfaces:**
- Produces: `buildSnapshot(db: Db, boardId: string, viewer: { participantId: string; isAdmin: boolean }, opts: { onlinePublicIds: Set<string>; confluenceConnected: boolean; now: number }): Promise<BoardSnapshot>`.
  - Notes: include note iff `isPublic || authorId === viewer.participantId`. `votes` = total count; `myVotes` = viewer's count. Default order `createdAt` asc (client sorts).
  - `votesRemaining = max(0, voteLimit - viewerVotes)`.
  - `participants`: all participants of the board (no `clientId`, no internal `id` — only `publicId`).
  - `actionItems.canEdit` = viewer is creator or admin.
  - `export`: `null` unless `isAdmin`; `status` = `'not_connected'` when `!confluenceConnected`, else `boards.export_status`.
  - `serverNow = opts.now`.
- Must never put `clientId`, `adminTokenHash`, or internal participant `id` in the payload.

- [ ] **Step 1: Failing tests**

```ts
test('private notes are visible only to their author', async () => {
  const s1 = await buildSnapshot(db, b, { participantId: ann.id, isAdmin: false }, opts);
  const s2 = await buildSnapshot(db, b, { participantId: bob.id, isAdmin: true }, opts);
  expect(s1.notes.map(n => n.text)).toEqual(['ann private', 'ann public']);
  expect(s2.notes.map(n => n.text)).toEqual(['ann public']);   // even admin can't see
});
test('payload contains no secrets', async () => {
  const json = JSON.stringify(await buildSnapshot(db, b, { participantId: ann.id, isAdmin: true }, opts));
  expect(json).not.toContain(ann.clientId); expect(json).not.toContain(ann.id); expect(json).not.toContain(board.adminTokenHash);
});
test('votes and myVotes and votesRemaining', ...);
test('export is null for non-admin and not_connected when disconnected', ...);
test('online flag from onlinePublicIds; isMe flag set', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add per-viewer board snapshot`.

---

### Task 10: HTTP app, board creation, health, static

**Files:**
- Create: `src/server/http/app.ts`, `src/server/http/board-routes.ts`, `src/server/index.ts`
- Test: `src/server/http/board-routes.test.ts`

**Interfaces:**
- Consumes: `Config`, `Db`, `createBoard`, `matchesAny`, `getDefaults` (Task 12 — until then pass `null`).
- Produces:
  - `type AppDeps = { config: Config; db: Db; now: () => number; fetch: typeof fetch }`.
  - `buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; io: Server<ClientToServer, ServerToClient> }>` — registers cookie (signed with `SESSION_SECRET`), rate-limit (global off; per-route), routes, static `dist/client` with SPA fallback (only when the folder exists), Socket.IO attached to `app.server` (wired in Task 11).
  - `GET /healthz` → `200 {"ok":true}` after `SELECT 1`; `503` if DB fails.
  - `POST /api/boards` body `{ name: string; inviteCode: string }` → `201 { boardId, adminToken, participantUrl, adminUrl }` where URLs = `${publicBaseUrl}/b/${id}` and `?admin=${token}`. Invalid code → `403 { error: 'forbidden' }`. Rate limit 10/min/IP → `429`.
  - `index.ts`: `loadConfig(process.env)` → `createDb` → `migrateDb` → `buildApp` → `listen({ host: '0.0.0.0', port })`; graceful shutdown on SIGTERM/SIGINT (close io, app, pool). Logger: Fastify pino JSON; redact `req.headers.cookie`, `req.query.admin`, `req.headers["x-admin-token"]`.

- [ ] **Step 1: Failing tests** (use `app.inject`, `createTestDb`)

```ts
test('creates board with valid invite code', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/boards', payload: { name: 'Sprint', inviteCode: 'beta' } });
  expect(r.statusCode).toBe(201);
  const body = r.json(); expect(body.adminUrl).toBe(`https://retro.example.com/b/${body.boardId}?admin=${body.adminToken}`);
});
test('rejects bad invite code with 403', ...);
test('rate limits creation attempts after 10/min', ...);   // 11th → 429
test('healthz', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add HTTP app with invite-only board creation`.

---

### Task 11: Real-time Socket.IO layer

**Files:**
- Create: `src/server/realtime/socket.ts`, `src/server/realtime/presence.ts`, `src/server/realtime/rate-limit.ts`
- Modify: `src/server/http/app.ts` (call `attachRealtime`)
- Test: `src/server/realtime/socket.test.ts` (real server on port 0 + `socket.io-client`)

**Interfaces:**
- Consumes: all services (Tasks 4–9), `buildSnapshot`.
- Produces:
  - `attachRealtime(io, deps: AppDeps & { isConfluenceConnected: () => Promise<boolean>; onClosed: (boardId: string) => void }): { broadcastBoard(boardId: string): Promise<void> }`.
  - Handshake: `socket.handshake.auth: JoinAuth`. Middleware loads board (`connect_error` message `not_found`), validates name, `upsertParticipant`, sets `socket.data = { boardId, participantId, publicId, isAdmin: verifyAdmin(...) }`, joins room `board:${boardId}`, marks presence, then `broadcastBoard`.
  - `broadcastBoard(boardId)`: for each socket in the room, `buildSnapshot` for that socket's viewer and emit `board:state`. (Cache per participantId+isAdmin within one broadcast.)
  - Every handler: rate-limit check (`createRateLimiter({ capacity: 30, refillPerSec: 3 })` per socket → `rate_limited`), admin handlers check `socket.data.isAdmin` → `forbidden`, call service, ack `{ok:true}` then `broadcastBoard`; map `DomainError` to `{ ok:false, error, message }`, anything else → `internal` (logged).
  - `admin:close` → `closeBoard` → broadcast → `onClosed(boardId)` (Task 14 starts export).
  - `admin:delete` → emit `board:deleted` to room, `deleteBoard`, `io.in(room).disconnectSockets()`.
  - Presence: `createPresence()` with `join(boardId, publicId)`, `leave(...)`, `online(boardId): Set<string>` — ref-counted per publicId so two tabs count once; disconnect → leave → broadcast.

- [ ] **Step 1: Failing tests**

```ts
test('private note reaches only its author; sharing reaches everyone', async () => {
  const ann = await join({ name: 'Ann' }); const bob = await join({ name: 'Bob' });
  const { noteId } = await addAndGetId(ann, { columnIndex: 0, text: 'secret' });
  expect(lastState(bob).notes).toHaveLength(0);
  await emit(ann, 'note:share', { noteId });
  expect(lastState(bob).notes[0]).toMatchObject({ text: 'secret', authorName: 'Ann', isPublic: true });
});
test('participant link cannot run admin events', async () => {
  const bob = await join({ name: 'Bob' });
  expect(await emit(bob, 'admin:close', {})).toEqual({ ok: false, error: 'forbidden', message: expect.any(String) });
});
test('wrong admin token joins as non-admin', ...);       // isAdmin false in snapshot
test('unknown board → connect_error not_found', ...);
test('same participant in two tabs receives private notes in both', async () => {
  const t1 = await join({ name: 'Ann', participantId: 'same' }); const t2 = await join({ name: 'Ann', participantId: 'same' });
  await emit(t1, 'note:add', { columnIndex: 1, text: 'mine' });
  expect(lastState(t2).notes.map(n => n.text)).toEqual(['mine']);
  expect(lastState(t2).participants.filter(p => p.online)).toHaveLength(1);
});
test('reconnect receives full fresh state', async () => {
  // disconnect client, add a public note from another client, reconnect → first board:state contains it
});
test('closed board rejects writes with board_closed; reopen re-enables', ...);
test('delete emits board:deleted and disconnects', ...);
test('31st rapid event is rate_limited', ...);
test('close calls onClosed once', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add real-time board channel`.

---

### Task 12: Owner settings and Atlassian OAuth

**Files:**
- Create: `src/server/confluence/connection-store.ts`, `src/server/confluence/oauth.ts`, `src/server/http/settings-routes.ts`
- Test: `src/server/confluence/oauth.test.ts`, `src/server/http/settings-routes.test.ts`

**Interfaces:**
- Consumes: `encrypt/decrypt`, `safeEqual`, `AppDeps.fetch`.
- Produces (`oauth.ts`), constants: `AUTH_URL = 'https://auth.atlassian.com/authorize'`, `TOKEN_URL = 'https://auth.atlassian.com/oauth/token'`, `RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources'`, `SCOPES = ['read:space:confluence','read:page:confluence','write:page:confluence','offline_access']`.
  - `buildAuthorizeUrl(cfg, state: string): string` (audience `api.atlassian.com`, `response_type=code`, `prompt=consent`, `redirect_uri=${publicBaseUrl}/api/settings/atlassian/callback`).
  - `exchangeCode(deps, code): Promise<Tokens>`; `refreshTokens(deps, refreshToken): Promise<Tokens>`; `type Tokens = { accessToken; refreshToken; expiresAt: Date }`.
  - `listSites(deps, accessToken): Promise<{ id: string; url: string; name: string }[]>`.
- Produces (`connection-store.ts`):
  - `saveTokens(db, key, tokens)`, `setSite(db, site)`, `setDefaults(db, defaults)`, `disconnect(db)`, `getConnectionInfo(db): Promise<{ connected: boolean; site: {id,url,name}|null; defaults: {...}|null }>` (no tokens), `isConnected(db): Promise<boolean>` (tokens + site present), `getDefaults(db)`.
  - `getAccessToken(deps): Promise<{ token: string; cloudId: string; siteUrl: string }>` — refreshes when `expiresAt - now < 60s`, **persists the rotated refresh token**, throws `DomainError('forbidden', 'Atlassian connection expired — owner needs to reconnect in Settings')` if refresh fails with 4xx.
- Produces routes (all except login require signed cookie `owner=1`, else 401):
  - `POST /api/settings/login` `{ secret }` → sets signed httpOnly, `secure` when base URL is https, `sameSite=lax` cookie, 8h; wrong → 401; rate limit 5/min/IP.
  - `POST /api/settings/logout`.
  - `GET /api/settings` → `getConnectionInfo` + `{ atlassianConfigured: boolean }`.
  - `GET /api/settings/atlassian/connect` → sets signed `oauth_state` cookie (randomId(16), 10 min) and 302 to authorize URL.
  - `GET /api/settings/atlassian/callback?code&state` → state must match cookie (else 400), exchange, save tokens, list sites; if exactly one, `setSite`; 302 to `/settings`.
  - `GET /api/settings/atlassian/sites`, `PUT /api/settings/atlassian/site { id }`, `PUT /api/settings/defaults { spaceId, spaceName, parentId?, parentTitle? }`, `POST /api/settings/atlassian/disconnect`.
  - If `config.atlassian` is null, Atlassian routes → 404 and settings shows "not configured".

- [ ] **Step 1: Failing tests** (fake `fetch` returning canned Atlassian JSON)

```ts
test('settings routes require owner cookie', ...);              // GET /api/settings → 401 without, 200 after login
test('callback rejects mismatched state', ...);                  // 400, no tokens saved
test('callback stores encrypted tokens and auto-selects single site', async () => {
  // after callback: raw DB row access_token_enc !== 'at-1' and decrypt(...) === 'at-1'; site set
});
test('getAccessToken refreshes near expiry and persists rotated refresh token', ...);
test('getAccessToken failing refresh throws reconnect message', ...);
test('GET /api/settings never includes tokens', ...);           // JSON has no 'at-1'/'rt-1'
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add owner settings and Atlassian OAuth`.

---

### Task 13: Confluence client and page renderer

**Files:**
- Create: `src/server/confluence/confluence-client.ts`, `src/server/confluence/render.ts`
- Test: `src/server/confluence/render.test.ts`, `src/server/confluence/confluence-client.test.ts`

**Interfaces:**
- Produces (`confluence-client.ts`), base `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2`:
  - `class ConfluenceError extends Error { status: number }`
  - `listSpaces(c: ClientCtx, query?: string): Promise<{ id; key; name }[]>` (`GET /spaces?limit=50`, filter by name client-side)
  - `searchPages(c, spaceId, title: string): Promise<{ id; title }[]>` (`GET /spaces/{id}/pages?title=...&limit=25`; when title empty, first 25)
  - `getPage(c, id): Promise<{ id; version: number; title } | null>` (404 → null)
  - `createPage(c, { spaceId, parentId|null, title, storage }): Promise<{ id; version; url }>` (`POST /pages`, `status: 'current'`, `body.representation: 'storage'`; url = `${siteUrl}/wiki${_links.webui}`)
  - `updatePage(c, { id, title, storage, version }): Promise<{ id; version; url }>` (`PUT /pages/{id}`, `version.number = version`)
  - `type ClientCtx = { fetch: typeof fetch; token: string; cloudId: string; siteUrl: string }`
- Produces (`render.ts`): `type ExportData = { boardName: string; date: string; participants: string[]; columns: { name: string; notes: { text: string; author: string; votes: number }[] }[]; actionItems: { text: string; owner: string; noteText: string|null }[] }`; `pageTitle(boardName: string, date: string): string`; `renderStorage(d: ExportData): string`; `escapeXml(s: string): string`.
  - Layout: `<p>` with date + participants; per column `<h2>name</h2>` then `<ul>` of `<li>text — <em>author</em> (N votes)</li>` (empty → `<p><em>No notes</em></p>`); `<h2>Action items</h2>` + `<table>` with header row Item/Owner/From note. Newlines in text → `<br/>`.

- [ ] **Step 1: Failing tests**

```ts
test('title format', () => expect(pageTitle('Sprint 42', '2026-10-30')).toBe('Retro – Sprint 42 – 2026-10-30'));
test('escapes hostile text', () => {
  const xml = renderStorage({ ...data, columns: [{ name: 'A&B', notes: [{ text: '<script>x</script> ]]> 🎉\nline2', author: 'Ann', votes: 3 }] }] });
  expect(xml).toContain('A&amp;B'); expect(xml).toContain('&lt;script&gt;'); expect(xml).not.toContain('<script>');
  expect(xml).toContain(']]&gt;'); expect(xml).toContain('🎉'); expect(xml).toContain('<br/>');
});
test('renders action items table and empty-column placeholder', ...);
test('createPage posts v2 payload and builds url', ...);     // assert request body shape & Authorization: Bearer
test('getPage returns null on 404; non-2xx throws ConfluenceError with status', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add Confluence client and storage renderer`.

---

### Task 14: Export service and board Confluence routes

**Files:**
- Create: `src/server/confluence/export-service.ts`
- Modify: `src/server/http/board-routes.ts`, `src/server/http/app.ts` (wire `onClosed` → `exportBoard(…, 'auto')`, `isConfluenceConnected` → `isConnected`, `createBoard` defaults → `getDefaults`)
- Test: `src/server/confluence/export-service.test.ts`, extend `board-routes.test.ts`

**Interfaces:**
- Consumes: `getAccessToken`, Confluence client, `renderStorage`, `pageTitle`, `broadcastBoard`.
- Produces:
  - `collectExportData(db, boardId): Promise<ExportData>` — public notes only, sorted votes desc then `sharedAt` asc; participants = names of participants who authored a public note, voted, or created an action item (deduped, sorted); date from `closed_at ?? now`.
  - `exportBoard(deps: AppDeps & { notify: (boardId: string) => Promise<void> }, boardId: string, mode: 'auto'|'overwrite'|'new'): Promise<void>` — never throws; outcome recorded on the board:
    1. Not connected → `export_status='failed'`, error `Confluence is not connected — the owner can connect it in Settings`. (`auto` mode with no connection: leave status unchanged, do nothing.)
    2. No `confluence_space_id` → `failed`, `Choose a Confluence space for this board first`.
    3. Set `pending`, notify.
    4. If `page_id` and mode ≠ `new`: `getPage`; null → create; `version !== confluence_page_version` and mode ≠ `overwrite` → `conflict` (error: `The Confluence page was edited after the last export`); else `updatePage` with `version + 1`.
    5. Else create. On create 400/409 with title-exists message, retry with ` (2)`…` (10)`.
    6. Success → store `page_id`, `page_version`, `page_url`, `export_status='success'`, clear error. `ConfluenceError` 401/`forbidden` DomainError → reconnect message; 403 → `No permission to create pages in this Confluence space`; 404 on parent → `Parent page not found — pick another`; else `Export failed: <status>` (logged).
    7. Notify.
  - Concurrency: an in-memory `Set<boardId>` guard; a second call while one is running returns immediately.
- Produces routes (header `x-admin-token` checked with `verifyAdmin`, else 403; Confluence not connected → 409):
  - `GET /api/boards/:id/confluence/spaces?q=`
  - `GET /api/boards/:id/confluence/pages?spaceId=&q=`
  - `PUT /api/boards/:id/export-target { spaceId, spaceName, parentId|null, parentTitle|null }` → stores, notify.
  - `POST /api/boards/:id/export { mode: 'overwrite'|'new'|'auto' }` → `202`, runs `exportBoard` (allowed on open or closed boards).

- [ ] **Step 1: Failing tests** (fake Confluence via injected fetch; in-memory page store with versions)

```ts
test('close auto-exports a new page with public notes only', ...);   // page body lacks private text; status success; page_url stored
test('re-export updates same page with version+1', ...);
test('conflict when page edited externally; overwrite succeeds; new creates second page', ...);
test('deleted page is recreated', ...);
test('create retries with suffix on title conflict', ...);           // title 'Retro – S – 2026-10-30 (2)'
test('403 maps to no-permission message; data intact', ...);
test('auto mode with no connection does nothing', ...);
test('export routes require admin token', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: export boards to Confluence`.

---

### Task 15: Client shell, identity, socket hook, home page

**Files:**
- Create: `src/client/index.html`, `src/client/main.tsx`, `src/client/App.tsx`, `src/client/styles.css`, `src/client/lib/identity.ts`, `src/client/lib/useBoard.ts`, `src/client/pages/HomePage.tsx`
- Test: `src/client/lib/identity.test.ts`, `src/client/pages/HomePage.test.tsx`

**Interfaces:**
- Produces:
  - Routes: `/` → `HomePage`, `/b/:boardId` → `BoardPage`, `/settings` → `SettingsPage`.
  - `getIdentity(): { participantId: string; name: string | null }` (creates & stores `crypto.randomUUID()` under `retro.participantId`; every storage access in try/catch, falling back to in-memory), `setName(name: string)` (`retro.name`).
  - `useBoard(boardId: string, auth: { participantId: string; name: string; adminToken?: string } | null): { state: BoardSnapshot | null; receivedAt: number; status: 'connecting'|'connected'|'reconnecting'|'not_found'|'deleted'; emit<E extends keyof ClientToServer>(event: E, payload: Parameters<ClientToServer[E]>[0]): Promise<Ack> }` — socket.io-client with `auth`, auto-reconnect; emits rejected after 10s timeout → `{ ok:false, error:'internal', message:'Request timed out' }`.
  - `HomePage`: form (board name, invite code) → `POST /api/boards`; on success shows both links with copy buttons and clear "keep the admin link secret" copy, plus "Open as admin" button; 403 → "That invite code isn't valid."
  - `styles.css`: color tokens on `:root` with dark-mode override; responsive grid (4 columns ≥1100px, 2 ≥700px, 1 below).

- [ ] **Step 1: Failing tests**

```ts
test('identity persists participantId and survives storage errors', () => {
  const a = getIdentity(); expect(getIdentity().participantId).toBe(a.participantId);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(getIdentity().participantId).toMatch(/[0-9a-f-]{36}/);
});
test('HomePage shows both links after creating', async () => {
  // mock fetch 201 → expect participant URL and admin URL text visible
});
test('HomePage shows invite error on 403', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add client shell and board creation page`.

---

### Task 16: Board page — join, columns, notes, voting, presence

**Files:**
- Create: `src/client/pages/BoardPage.tsx`, `src/client/components/JoinPrompt.tsx`, `Column.tsx`, `NoteCard.tsx`, `Presence.tsx`
- Test: `src/client/components/Column.test.tsx`, `src/client/pages/BoardPage.test.tsx`

**Interfaces:**
- Consumes: `useBoard`, `getIdentity`, `setName`, `BoardSnapshot`.
- Produces:
  - `BoardPage`: reads `?admin=` and keeps it in memory for the socket auth; shows `JoinPrompt` until a name exists; then header (board name, status badge "Closed" when closed, votes remaining), `TimerBar`, 4 `Column`s, `Presence`, `ActionItems`, and `AdminPanel` when `state.isAdmin`. `not_found` → "This board doesn't exist or was deleted." Connection banner while `reconnecting`. Toast for `{ok:false}` acks using `message`.
  - `Column({ index, name, notes, sort, onAdd, onEdit, onDelete, onShare, onVote, onUnvote, readOnly, isAdmin })`: "Only you" private area (my unshared notes + add textarea, Ctrl/Cmd+Enter submits, char counter at 1000) and "Shared" public area. Sort toggle Newest/Votes (per viewer, persisted in localStorage `retro.sort`).
  - `NoteCard`: text rendered as plain text with `white-space: pre-wrap` (never `dangerouslySetInnerHTML`); author name; vote count; +/- vote buttons (disabled when 0 remaining / 0 myVotes / readOnly); Share button on private; Edit/Delete for mine; Delete for admin on public.

- [ ] **Step 1: Failing tests**

```ts
test('private notes show Share; public notes show author and votes', ...);
test('note text with <b>hi</b> renders literally', () => {
  render(<Column {...props} notes={[note({ text: '<b>hi</b>', isPublic: true })]} />);
  expect(screen.getByText('<b>hi</b>')).toBeInTheDocument();
});
test('vote button disabled when votesRemaining is 0', ...);
test('readOnly hides add box and edit controls', ...);
test('BoardPage asks for a name first', ...);   // mock useBoard
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add board page with notes, voting and presence`.

---

### Task 17: Timer bar, action items, admin and export panels

**Files:**
- Create: `src/client/components/TimerBar.tsx`, `ActionItems.tsx`, `AdminPanel.tsx`, `ExportPanel.tsx`
- Test: `src/client/components/TimerBar.test.tsx`, `ExportPanel.test.tsx`

**Interfaces:**
- Consumes: `clientRemainingMs`, `useBoard().emit`, board Confluence routes (Task 14) with `x-admin-token`.
- Produces:
  - `TimerBar({ timer, serverNow, receivedAt, isAdmin, emit })`: mm:ss ticking every 250ms via `clientRemainingMs`; at 0 shows "Time's up" highlight and plays a short sound once per run if the viewer enabled sound (toggle, localStorage `retro.sound`); admin controls: duration presets (3/5/10 min + custom minutes), Start, Pause/Resume, Reset, +1 min.
  - `ActionItems({ items, notes, participants, readOnly, emit })`: add form (text, owner input with `<datalist>` of participant names, optional "from note" select listing public notes), list with edit/delete when `canEdit`.
  - `AdminPanel({ state, adminToken, emit })`: rename columns (inline inputs, save on blur/Enter), vote limit number input, Close session (confirm dialog) / Reopen, Delete board (type board name to confirm), shows participant link to copy.
  - `ExportPanel({ boardId, adminToken, exportView })`: `not_connected` → "Confluence isn't connected. The owner can connect it in Settings."; space select (search) + optional parent page search; Save target; "Export to Confluence"/"Export again"; `pending` spinner; `success` link to page; `conflict` → message + "Overwrite" + "Create new page"; `failed` → error + "Try again".

- [ ] **Step 1: Failing tests**

```ts
test('TimerBar shows server-based remaining despite local clock skew', ...);  // fake timers; expects "00:45"
test('TimerBar hides controls for non-admin', ...);
test('ExportPanel conflict shows Overwrite and Create new page and posts mode', ...);
test('ExportPanel success shows page link', ...);
```

- [ ] **Steps 2–5:** run → FAIL, implement, run → PASS, commit `feat: add timer, action items and admin panels`.

---

### Task 18: Owner settings page

**Files:**
- Create: `src/client/pages/SettingsPage.tsx`
- Test: `src/client/pages/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: Task 12 routes.
- Produces: `SettingsPage`: owner secret login form (401 → "Wrong secret"); when Atlassian not configured → explains env vars; when not connected → "Connect with Atlassian" (navigates to `/api/settings/atlassian/connect`); when connected → site (picker if multiple), default space + parent picker (reuses the space/page search via `/api/settings` equivalents: add `GET /api/settings/confluence/spaces?q=` and `/pages?spaceId=&q=` to Task 12 routes file, owner-cookie guarded, same client functions), Disconnect, Log out.

- [ ] **Step 1: Failing tests:** login error message; connected state shows site name and Disconnect; not-configured state shows env var names.
- [ ] **Steps 2–5:** run → FAIL, implement (plus the two owner picker routes with a route test each), run → PASS, commit `feat: add owner settings page`.

---

### Task 19: Docker packaging, smoke test, README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `scripts/smoke.ts`, `README.md`

**Interfaces:**
- Consumes: `npm run build` outputs `dist/client`, `dist/server/index.js`; `drizzle/` migrations folder (copied into image; `migrateDb` resolves it relative to `process.cwd()`).
- Produces:
  - `Dockerfile`: stage `deps` (`node:22-alpine`, `npm ci`), stage `build` (`npm run build`, `npm prune --omit=dev`), stage `runtime` (`node:22-alpine`, `NODE_ENV=production`, copy `node_modules`, `dist`, `drizzle`, `package.json`; `USER node`; `EXPOSE 3000`; `HEALTHCHECK` via `wget -qO- http://localhost:3000/healthz`; `CMD ["node","dist/server/index.js"]`).
  - `docker-compose.yml`: `db` (`postgres:16-alpine`, volume `pgdata`, healthcheck `pg_isready`), `app` (build `.`, `env_file: .env`, `DATABASE_URL=postgres://retro:${POSTGRES_PASSWORD}@db:5432/retro`, `depends_on: db: condition: service_healthy`, ports `3000:3000`, `restart: unless-stopped`). Add `POSTGRES_PASSWORD` to `.env.example`.
  - `scripts/smoke.ts` (`BASE_URL`, `INVITE_CODE` env): GET `/healthz`; POST `/api/boards`; connect two socket clients (one admin); admin adds note → other does not see it; share → other sees it; vote; start timer; close → both see `status: 'closed'`; GET `/` returns HTML. Exit non-zero on any failure, print each check.
  - `README.md`: what it is; quick start (`cp .env.example .env`, fill, `docker compose up -d --build`, open `http://localhost:3000`); env var table; registering the Atlassian OAuth 2.0 (3LO) app (developer.atlassian.com → Create → OAuth 2.0 integration → Permissions: Confluence API, add the four scopes → Authorization callback URL `${PUBLIC_BASE_URL}/api/settings/atlassian/callback` → copy client ID/secret); deploying to Fly.io (`fly launch`, `fly postgres create`/attach, `fly secrets set ...`) and Railway (Dockerfile deploy + Postgres plugin); VPS with compose behind Caddy for HTTPS; backups (`pg_dump` cron for VPS); upgrading (pull, `docker compose up -d --build`, migrations run on start).

- [ ] **Step 1: Build image** `docker build -t retro-board .` → succeeds; `docker run --rm retro-board id -u` → not `0`.
- [ ] **Step 2: Fresh-checkout run**

```bash
git clone . /tmp/retro-clean && cd /tmp/retro-clean && cp .env.example .env   # fill test values
docker compose up -d --build
docker compose ps        # app healthy, db healthy
```

- [ ] **Step 3: Smoke** `BASE_URL=http://localhost:3000 INVITE_CODE=<code> npm run smoke` → every check prints ✓, exit 0.
- [ ] **Step 4: Persistence check** `docker compose restart app` → board created in Step 3 still loads at `/b/<id>`.
- [ ] **Step 5: Full test suite** `npm test && npm run typecheck` → PASS.
- [ ] **Step 6: Tear down** `docker compose down` (keep volume), remove `/tmp/retro-clean`.
- [ ] **Step 7: Commit** `feat: package app with Docker and compose; add smoke test and README`
