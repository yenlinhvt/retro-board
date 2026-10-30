# Retro Board — Design

Date: 2026-10-30
Status: Approved 2026-10-30

## 1. Intent

A self-hosted, production-quality team retrospective board, similar in spirit to retrotool.io. A team uses it live in a sprint retro: everyone joins with a shared link, writes notes privately and shares them when ready, votes, agrees on action items, and the result lands in Confluence automatically when the session closes.

It is owned and hosted personally by the author, separate from any company infrastructure (Ninja Van). It must be reliable enough to use every sprint with a real team.

## 2. Goals

- Join instantly with a shareable link and a display name. No accounts.
- Live, real-time collaboration: public notes, votes, timer and action items update for everyone without refresh.
- Private-then-public note flow per column.
- Admin control via a separate secret admin link.
- One-click "Connect with Atlassian" (OAuth) and automatic Confluence page creation on close.
- Cheap and simple to self-host and operate.

## 3. Non-goals

- User accounts, sign-up, passwords, SSO for participants.
- Grouping / merging / clustering notes.
- Cross-board history, dashboards, team management, analytics.
- Integrations other than Confluence (Jira, Slack, etc.).
- Anonymous mode (authors are always shown on public notes).
- Native mobile apps (responsive web is enough).

## 4. Anti-goals (failure even if it "works")

- A private note is ever visible to anyone other than its author (including via the API, websocket payloads, or the Confluence export).
- The timer shows different times to different people, or resets on refresh.
- A participant link grants admin powers, or admin link is guessable.
- Confluence export silently fails and the retro content is lost.
- Atlassian tokens stored in plain text or exposed to the browser.

## 5. Users and roles

- **Owner**: the person running the instance. Holds the `OWNER_SECRET` (for `/settings`, Atlassian connection) and the invite code(s).
- **Board creation is invite-only**: the create-board form requires an invite code. Valid codes come from an `INVITE_CODES` env var (comma-separated) so the owner can rotate or revoke one by redeploying *(my call: env var, not a UI)*. Joining an existing board needs only its link, not an invite code.

- **Admin**: whoever creates the board. Receives two links on creation:
  - Participant link: `/b/{boardId}` — share with the team.
  - Admin link: `/b/{boardId}?admin={adminToken}` — secret, grants admin powers.
  - The admin also enters a display name and participates like anyone else. *(Builder's call recorded here: admin is also a participant.)*
- **Participant**: anyone with the participant link. On first open, prompted for a display name. A random participant ID + name are stored in the browser (localStorage), so a refresh keeps their identity and their private notes. Duplicate names are allowed. If they clear browser storage, they come back as a new participant and lose access to their unshared private notes. *(Accepted trade-off.)*

## 6. Board structure

- Exactly **4 columns**. Default names: "Went well", "To improve", "Ideas", "Shout-outs" *(my call)*. Admin can rename columns at any time while the board is open.
- Each column has two areas:
  - **Private area**: shows only the current participant's own unshared notes.
  - **Public area**: shows all shared notes from everyone, with author name and vote count.
- Participants see a presence list of who is currently online *(my call)*.

## 7. Notes

- A participant adds a note (plain text, max ~1000 chars) to the private area of a column.
- The author can edit or delete their private note.
- The author clicks **Share** to move it to the public area. Everyone sees it immediately with the author's display name.
- Once public, a note **cannot be moved back to private** *(my call)*. The author can still edit or delete it; the admin can delete any public note.
- Public notes can be sorted by newest or by votes (per viewer toggle).
- Unshared private notes are never shown to others and are **excluded from the Confluence export**.

## 8. Voting

- Only public notes can be voted on.
- Admin sets a per-participant vote limit for the board (default 5).
- A participant may put multiple votes on the same note, and can remove their own votes.
- Vote counts are visible live to everyone. Who voted for what is not shown *(my call)*.
- Remaining votes are shown to each participant. The server enforces the limit.

## 9. Timer

- Admin sets a duration and controls: start, pause, resume, reset, +1 minute.
- The timer is server-authoritative: server stores the end time / remaining time; all clients render from that, so everyone sees the same countdown and refreshes don't reset it.
- At zero: visual + optional sound cue for everyone. Reaching zero does **not** close the session or lock editing.
- The admin may run the timer multiple times in a session (e.g. writing phase, then voting phase).

## 10. Action items

- A separate panel on the board.
- Each item: text, owner (free text, with suggestions from current participant names), optional link to the public note it came from.
- Any participant can add action items; author and admin can edit/delete *(my call)*.

## 11. Closing the session

- Admin clicks **Close session** (with confirmation).
- The board becomes read-only for everyone. It remains viewable via both links.
- If Confluence is connected, export runs automatically (see §12).
- Admin can **reopen** a closed board *(my call — cheap and saves mistakes)*.
- Admin can **delete** a board permanently.

## 12. Confluence integration

### Target
- **Confluence Cloud** (`*.atlassian.net`) only. Data Center / Server is out of scope.
- **Only the instance owner connects** to Atlassian. The OAuth app stays private (not distributed); no Atlassian marketplace/distribution setup or org-admin approval is needed.

### Connection (OAuth 2.0 3LO) — instance-level
- The owner registers one private OAuth 2.0 (3LO) app in the Atlassian developer console (setup steps documented in the repo README). Client ID/secret live in server env vars.
- **One connection for the whole instance** *(my call, follows from "only the owner connects")*: an owner settings page at `/settings`, protected by an `OWNER_SECRET` env var, has the **Connect with Atlassian** button → Atlassian consent → callback to `/settings`. The owner picks the Atlassian site (if more than one accessible resource) and can disconnect there.
- Access + refresh tokens are stored server-side, encrypted at rest (app-level encryption key from env). Refresh is automatic. Tokens never reach the browser.
- Each **board's admin view** shows the export target: space and optional parent page, chosen from dropdowns populated via the owner's connection. The owner can set a default space/parent on `/settings` that new boards inherit *(my call)*.
- All pages are created as the owner's Atlassian user.
- If the instance isn't connected, the board admin view says so and export is unavailable; the board otherwise works normally.

### Export
- Triggered automatically on close, and manually via **Export to Confluence** / **Export again** on the admin view.
- Page title: `Retro – {board name} – {YYYY-MM-DD}`, created under the chosen parent in the chosen space.
- Content:
  - Board name, date, participant names.
  - One section per column (using current column names): public notes sorted by votes desc, each with author and vote count.
  - Action items table: item, owner, linked note (if any).
- Re-export **updates the same page** (stored page ID + last exported page version) rather than creating duplicates. If that page was deleted in Confluence, create a new one.
- **Conflict protection** *(my call)*: before updating, compare the page's current Confluence version with the version the app last wrote. If someone edited the page in Confluence since then, do not overwrite silently. Mark the export as **conflict** and let the admin choose **Overwrite** or **Create new page**. Auto-export on close also stops at conflict and does not overwrite.
- Export status shown on admin view: not connected / pending / success (with link to page) / conflict / failed (with readable error, e.g. token expired → "Owner needs to reconnect", no permission in space).
- Export failure never loses data; the board stays intact and export can be retried.

## 13. How it gets made (my calls, approved direction)

- **Language**: TypeScript end to end.
- **Frontend**: React (Vite).
- **Backend**: Node.js, Fastify for HTTP, Socket.IO for real-time (one room per board).
- **Database**: Postgres.
- **Packaging (required deliverable)**: the whole system is packaged with Docker.
  - A multi-stage `Dockerfile` builds one production image that serves both the API and the built frontend, runs as a non-root user, and runs DB migrations on startup.
  - A `docker-compose.yml` runs the whole system (app + Postgres with a persistent volume) with `docker compose up`, configured through a `.env` file (`.env.example` provided with all variables: DB URL, `OWNER_SECRET`, `INVITE_CODES`, Atlassian client ID/secret, encryption key, public base URL).
  - The same image deploys unchanged to Fly.io/Railway (using their managed Postgres) or to a VPS (using the compose file).
  - Development is not finished until the system builds and runs from a clean checkout using only Docker.
- **Hosting**: Fly.io or Railway (container + managed Postgres, HTTPS, custom domain, backups), est. $5–15/month. A small VPS with Docker Compose is the documented fallback.
- The server is the source of truth for all state and all permission checks; clients only send intents.

## 14. Security and production requirements

- Board IDs and admin tokens are long random values (≥128 bits). Admin token stored hashed.
- Every write is authorized server-side: admin actions require admin token; note edits require participant ID match; private notes are filtered per recipient on every payload.
- Participant ID is a client-generated secret-ish UUID; acceptable risk for this use case (no accounts by design).
- Invite code checked server-side on board creation; owner secret checked on `/settings` and OAuth routes. Both compared in constant time.
- Rate limiting on board creation attempts (to slow invite-code guessing) and on writes.
- Retro content passes through the self-hosted server on its way to Confluence. Assumed acceptable; the owner should confirm this with their company if the content is company content.
- Input length limits; text rendered as plain text (no HTML injection). Confluence content properly escaped for storage format.
- Atlassian tokens encrypted at rest; OAuth `state` parameter validated.
- Health check endpoint, structured logs, DB backups (provider-managed), graceful reconnect on websocket drop with full state resync.
- Basic error tracking (e.g. Sentry) optional, builder's call.

## 15. Scale assumptions

- Typical board: up to ~30 concurrent participants, a few hundred notes. Single app instance is sufficient; no horizontal scaling required initially.

## 16. Data retention

- Boards are kept until the admin deletes them *(my call)*. No automatic expiry in v1.

## 17. Left to the builder

- Project structure, libraries beyond those named, ORM/migration tool, state management on the client.
- Visual design and layout details (should be clean, responsive, usable on a laptop screen during a call).
- Exact Atlassian OAuth scopes and Confluence API version (Cloud REST v2 preferred).
- Testing approach, CI, and deployment scripts.
- Exact Confluence page formatting.
