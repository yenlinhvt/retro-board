# Retro Board

A self-hosted, real-time sprint retrospective board. Participants join with a link and an invite code, write private notes, share them with the team, vote, run a facilitator timer, capture action items, and (optionally) export the finished retro to Confluence Cloud.

Stack: TypeScript, Fastify 5, Socket.IO 4, Postgres (Drizzle), React 18 + Vite.

## Quick start

```bash
cp .env.example .env
# fill in OWNER_SECRET, INVITE_CODES, SESSION_SECRET, ENCRYPTION_KEY, POSTGRES_PASSWORD
docker compose up -d --build
```

Open <http://localhost:3000>. Generate secrets with `openssl rand -base64 32`. Database migrations run automatically when the app starts.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Overridden by `docker-compose.yml` (built from `POSTGRES_PASSWORD`). |
| `POSTGRES_PASSWORD` | compose only | Password for the bundled Postgres container. |
| `PORT` | no (3000) | HTTP port the server listens on. |
| `TRUST_PROXY` | no (`false`) | Set `true` behind Fly.io, Railway or Caddy so rate limits see real client IPs. |
| `PUBLIC_BASE_URL` | yes | Public URL of the app, no trailing slash. Used for links and the OAuth redirect. |
| `OWNER_SECRET` | yes | At least 16 characters. Required to administer the instance (settings page). |
| `INVITE_CODES` | yes | Comma-separated codes that allow creating boards. |
| `SESSION_SECRET` | yes | At least 32 characters. Signs cookies. |
| `ENCRYPTION_KEY` | yes | Base64 of exactly 32 bytes. Encrypts Atlassian tokens at rest (AES-256-GCM). |
| `ATLASSIAN_CLIENT_ID` | no | Atlassian OAuth app client ID. Set together with the secret, or leave both blank to disable Confluence export. |
| `ATLASSIAN_CLIENT_SECRET` | no | Atlassian OAuth app client secret. |

## Confluence export

Export is optional. To enable it, register an Atlassian OAuth 2.0 (3LO) app:

1. Go to <https://developer.atlassian.com/console/myapps/> and choose **Create** -> **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Confluence API** and configure it with these scopes:
   - `read:space:confluence`
   - `read:page:confluence`
   - `write:page:confluence`
   - `offline_access` (refresh tokens; requested automatically during authorization)
3. Under **Authorization**, set the callback URL to `${PUBLIC_BASE_URL}/api/settings/atlassian/callback`, for example `https://retro.example.com/api/settings/atlassian/callback`. It must match `PUBLIC_BASE_URL` exactly.
4. Copy the client ID and secret into `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`, then restart the app.
5. Open `${PUBLIC_BASE_URL}/settings`, sign in with `OWNER_SECRET`, and click **Connect Atlassian**. Approve access for your site.
6. Choose the default Confluence space and (optionally) a default parent page. Board admins can override the target per board before exporting.

## Deployment

All options run the same Docker image and need `PUBLIC_BASE_URL` set to the final HTTPS URL and `TRUST_PROXY=true`.

### Fly.io

```bash
fly launch --no-deploy            # uses the Dockerfile; set internal_port = 3000
fly postgres create               # then: fly postgres attach <pg-app>  (sets DATABASE_URL)
fly secrets set PUBLIC_BASE_URL=https://<app>.fly.dev TRUST_PROXY=true \
  OWNER_SECRET=... INVITE_CODES=... SESSION_SECRET=... ENCRYPTION_KEY=... \
  ATLASSIAN_CLIENT_ID=... ATLASSIAN_CLIENT_SECRET=...
fly deploy
```

Run a single machine: realtime state is in-process, so do not scale horizontally.

### Railway

Create a project from the repo (Railway detects the Dockerfile), add the Postgres plugin, and set `DATABASE_URL` to the plugin's connection string reference. Add the other variables above, including `TRUST_PROXY=true` and `PUBLIC_BASE_URL` set to the generated domain.

### VPS with Docker Compose and Caddy

Run the compose stack on the server with `TRUST_PROXY=true` and `PUBLIC_BASE_URL=https://retro.example.com` in `.env`. Put Caddy in front for automatic HTTPS (WebSockets work with no extra config):

```
retro.example.com {
    reverse_proxy localhost:3000
}
```

Consider changing the app port mapping to `127.0.0.1:3000:3000` so only Caddy can reach it.

## Backups

All data lives in Postgres. On a VPS, schedule a dump with cron:

```bash
0 3 * * * cd /opt/retro && docker compose exec -T db pg_dump -U retro retro | gzip > /var/backups/retro-$(date +\%F).sql.gz
```

Restore with `gunzip -c backup.sql.gz | docker compose exec -T db psql -U retro retro`. On Fly.io or Railway use their managed Postgres backups/snapshots.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Migrations are applied automatically on start. Take a backup first for major upgrades.

## Verifying the Docker setup

1. Build: `docker build -t retro-board .` succeeds, and `docker run --rm retro-board id -u` prints a non-zero UID.
2. Run: `cp .env.example .env`, fill it in, `docker compose up -d --build`, then `docker compose ps` shows `app` and `db` healthy.
3. Smoke test: `BASE_URL=http://localhost:3000 INVITE_CODE=<one of INVITE_CODES> npm run smoke` prints a check mark for every step and exits 0.
4. Persistence: `docker compose restart app`, then open the board URL printed by the smoke test; it still loads.

## Development

```bash
npm install
npm run dev        # server (tsx watch) + Vite
npm test           # Vitest
npm run typecheck
npm run build      # dist/client + dist/server
```
