import { afterEach, beforeEach, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { atlassianConnection } from '../db/schema';
import type { Db } from '../db/client';
import { decrypt } from '../security/crypto';
import { createTestDb } from '../test/helpers';
import { buildApp } from './app';

const env = {
  DATABASE_URL: 'postgres://x',
  PUBLIC_BASE_URL: 'https://retro.example.com',
  OWNER_SECRET: 'owner-secret-1234567',
  INVITE_CODES: 'alpha',
  SESSION_SECRET: 's'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ATLASSIAN_CLIENT_ID: 'cid',
  ATLASSIAN_CLIENT_SECRET: 'csecret',
};

let app: FastifyInstance;
let db: Db;
let sites: { id: string; url: string; name: string }[];
let tokenStatus: number;
let resourcesStatus: number;

const fakeFetch = (async (url: string) => {
  const j = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url.endsWith('/oauth/token')) {
    return tokenStatus === 200
      ? j(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
      : j(tokenStatus, { error: 'bad' });
  }
  if (url.includes('accessible-resources')) return resourcesStatus === 200 ? j(200, sites) : j(resourcesStatus, {});
  return j(404, {});
}) as unknown as typeof fetch;

async function boot(extra: Record<string, string> = {}, withAtlassian = true) {
  db = await createTestDb();
  const e: Record<string, string> = { ...env, ...extra };
  if (!withAtlassian) {
    delete e.ATLASSIAN_CLIENT_ID;
    delete e.ATLASSIAN_CLIENT_SECRET;
  }
  ({ app } = await buildApp({ config: loadConfig(e), db, now: () => Date.now(), fetch: fakeFetch }));
}

beforeEach(() => {
  sites = [{ id: 'cloud-1', url: 'https://x.atlassian.net', name: 'X' }];
  tokenStatus = 200;
  resourcesStatus = 200;
});
afterEach(async () => {
  await app.close();
});

async function login(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/settings/login', payload: { secret: env.OWNER_SECRET } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((x) => x.name === 'owner')!;
  return `owner=${c.value}`;
}

/** Runs connect, returns cookie header with owner + oauth_state and the state. */
async function connect(ownerCookie: string) {
  const r = await app.inject({ method: 'GET', url: '/api/settings/atlassian/connect', headers: { cookie: ownerCookie } });
  expect(r.statusCode).toBe(302);
  const st = r.cookies.find((x) => x.name === 'oauth_state')!;
  const state = new URL(r.headers.location as string).searchParams.get('state')!;
  return { cookie: `${ownerCookie}; oauth_state=${st.value}`, state, res: r };
}

test('settings routes require owner cookie', async () => {
  await boot();
  expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: 'owner=1' } })).statusCode).toBe(401);
  const cookie = await login();
  const r = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ connected: false, site: null, defaults: null, atlassianConfigured: true });
});

test('login with wrong secret is 401 and cookie attributes are right', async () => {
  await boot();
  expect((await app.inject({ method: 'POST', url: '/api/settings/login', payload: { secret: 'nope' } })).statusCode).toBe(401);
  const r = await app.inject({ method: 'POST', url: '/api/settings/login', payload: { secret: env.OWNER_SECRET } });
  const c = r.cookies.find((x) => x.name === 'owner')!;
  expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 28800 });
});

test('cookie is not secure on http base url', async () => {
  await boot({ PUBLIC_BASE_URL: 'http://localhost:3000' });
  const r = await app.inject({ method: 'POST', url: '/api/settings/login', payload: { secret: env.OWNER_SECRET } });
  expect(r.cookies.find((x) => x.name === 'owner')!.secure).toBeFalsy();
});

test('login is rate limited to 5/min', async () => {
  await boot();
  for (let i = 0; i < 5; i++) {
    expect((await app.inject({ method: 'POST', url: '/api/settings/login', payload: { secret: 'x' } })).statusCode).toBe(401);
  }
  expect((await app.inject({ method: 'POST', url: '/api/settings/login', payload: { secret: 'x' } })).statusCode).toBe(429);
});

test('logout clears the owner cookie', async () => {
  await boot();
  const r = await app.inject({ method: 'POST', url: '/api/settings/logout' });
  expect(r.statusCode).toBe(200);
  expect(r.cookies.find((x) => x.name === 'owner')!.value).toBe('');
});

test('connect redirects to Atlassian with state cookie', async () => {
  await boot();
  const { res, state } = await connect(await login());
  expect(res.headers.location).toContain('https://auth.atlassian.com/authorize?');
  expect(state.length).toBeGreaterThan(16);
  expect(res.cookies.find((x) => x.name === 'oauth_state')).toMatchObject({ httpOnly: true, path: '/api/settings/atlassian', maxAge: 600 });
});

test('callback rejects mismatched state', async () => {
  await boot();
  const { cookie } = await connect(await login());
  const r = await app.inject({ method: 'GET', url: '/api/settings/atlassian/callback?code=c&state=wrong', headers: { cookie } });
  expect(r.statusCode).toBe(400);
  expect(await db.select().from(atlassianConnection)).toHaveLength(0);
});

test('callback with no state cookie is 400', async () => {
  await boot();
  const r = await app.inject({ method: 'GET', url: '/api/settings/atlassian/callback?code=c&state=x', headers: { cookie: await login() } });
  expect(r.statusCode).toBe(400);
});

test('callback stores encrypted tokens and auto-selects single site', async () => {
  await boot();
  const { cookie, state } = await connect(await login());
  const r = await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?code=c&state=${state}`, headers: { cookie } });
  expect(r.statusCode).toBe(302);
  expect(r.headers.location).toBe('/settings');
  const [row] = await db.select().from(atlassianConnection).where(eq(atlassianConnection.id, 1));
  expect(row!.accessTokenEnc).not.toBe('at-1');
  expect(decrypt(row!.accessTokenEnc, loadConfig(env).encryptionKey)).toBe('at-1');
  expect(row!.cloudId).toBe('cloud-1');
  expect(r.cookies.find((x) => x.name === 'oauth_state')!.value).toBe('');
});

test('callback with several sites leaves site unset; site can then be chosen only from the list', async () => {
  sites.push({ id: 'cloud-2', url: 'https://y.atlassian.net', name: 'Y' });
  await boot();
  const owner = await login();
  const { cookie, state } = await connect(owner);
  await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?code=c&state=${state}`, headers: { cookie } });
  let info = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: owner } })).json();
  expect(info).toMatchObject({ connected: true, site: null });
  const list = await app.inject({ method: 'GET', url: '/api/settings/atlassian/sites', headers: { cookie: owner } });
  expect(list.json().sites).toHaveLength(2);
  const bad = await app.inject({ method: 'PUT', url: '/api/settings/atlassian/site', headers: { cookie: owner }, payload: { id: 'evil' } });
  expect(bad.statusCode).toBe(400);
  const ok = await app.inject({ method: 'PUT', url: '/api/settings/atlassian/site', headers: { cookie: owner }, payload: { id: 'cloud-2' } });
  expect(ok.statusCode).toBe(200);
  info = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: owner } })).json();
  expect(info.site).toEqual(sites[1]);
});

test('callback redirects with error code when Atlassian denies or exchange fails', async () => {
  await boot();
  const owner = await login();
  let c = await connect(owner);
  let r = await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?error=access_denied&state=${c.state}`, headers: { cookie: c.cookie } });
  expect(r.statusCode).toBe(302);
  expect(r.headers.location).toBe('/settings?error=atlassian_denied');
  tokenStatus = 400;
  c = await connect(owner);
  r = await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?code=c&state=${c.state}`, headers: { cookie: c.cookie } });
  expect(r.headers.location).toBe('/settings?error=atlassian_failed');
});

test('GET /api/settings never includes tokens', async () => {
  await boot();
  const owner = await login();
  const { cookie, state } = await connect(owner);
  await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?code=c&state=${state}`, headers: { cookie } });
  const r = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: owner } });
  expect(r.body).not.toContain('at-1');
  expect(r.body).not.toContain('rt-1');
  expect(r.json().connected).toBe(true);
});

test('defaults are validated and saved; disconnect clears everything', async () => {
  await boot();
  const owner = await login();
  const { cookie, state } = await connect(owner);
  await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?code=c&state=${state}`, headers: { cookie } });
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings/defaults', headers: { cookie: owner }, payload: payload as object });
  expect((await put({ spaceId: '', spaceName: 'S' })).statusCode).toBe(400);
  expect((await put({ spaceId: '1', spaceName: 'x'.repeat(201) })).statusCode).toBe(400);
  expect((await put({ spaceId: '1', spaceName: 'Space' })).statusCode).toBe(200);
  let info = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: owner } })).json();
  expect(info.defaults).toEqual({ spaceId: '1', spaceName: 'Space', parentId: null, parentTitle: null });
  expect((await put({ spaceId: '1', spaceName: 'Space', parentId: '9', parentTitle: 'P' })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/settings/atlassian/disconnect', headers: { cookie: owner } })).statusCode).toBe(200);
  info = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: owner } })).json();
  expect(info).toMatchObject({ connected: false, site: null, defaults: null });
});

test('atlassian routes are 404 when not configured', async () => {
  await boot({}, false);
  const owner = await login();
  const r = await app.inject({ method: 'GET', url: '/api/settings/atlassian/connect', headers: { cookie: owner } });
  expect(r.statusCode).toBe(404);
  const s = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: owner } });
  expect(s.json().atlassianConfigured).toBe(false);
});

test('defaults without a connection is 409 and writes nothing', async () => {
  await boot();
  const owner = await login();
  const r = await app.inject({ method: 'PUT', url: '/api/settings/defaults', headers: { cookie: owner }, payload: { spaceId: '1', spaceName: 'S' } });
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'not_connected' });
});

test('empty parent strings are stored as null', async () => {
  await boot();
  const owner = await login();
  const { cookie, state } = await connect(owner);
  await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?code=c&state=${state}`, headers: { cookie } });
  await app.inject({ method: 'PUT', url: '/api/settings/defaults', headers: { cookie: owner }, payload: { spaceId: '1', spaceName: 'S', parentId: '', parentTitle: '' } });
  const info = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: owner } })).json();
  expect(info.defaults).toEqual({ spaceId: '1', spaceName: 'S', parentId: null, parentTitle: null });
});

test('sites returns 403 reconnect message when the token is revoked or refresh is rejected', async () => {
  await boot();
  const owner = await login();
  const { cookie, state } = await connect(owner);
  await app.inject({ method: 'GET', url: `/api/settings/atlassian/callback?code=c&state=${state}`, headers: { cookie } });
  const msg = 'Atlassian connection expired — owner needs to reconnect in Settings';
  // refresh rejected: force expiry
  await db.update(atlassianConnection).set({ expiresAt: new Date(0) });
  tokenStatus = 400;
  let r = await app.inject({ method: 'GET', url: '/api/settings/atlassian/sites', headers: { cookie: owner } });
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ error: 'forbidden', message: msg });
  // revoked access token: resources endpoint returns 401
  tokenStatus = 200;
  await db.update(atlassianConnection).set({ expiresAt: new Date(Date.now() + 3_600_000) });
  resourcesStatus = 401;
  r = await app.inject({ method: 'GET', url: '/api/settings/atlassian/sites', headers: { cookie: owner } });
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ error: 'forbidden', message: msg });
});
