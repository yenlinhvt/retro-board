import { beforeEach, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config';
import type { Db } from '../db/client';
import { atlassianConnection } from '../db/schema';
import { DomainError } from '../errors';
import { decrypt } from '../security/crypto';
import { createTestDb } from '../test/helpers';
import { getAccessToken, saveTokens, setSite } from './connection-store';
import { buildAuthorizeUrl, exchangeCode } from './oauth';

const config = loadConfig({
  DATABASE_URL: 'postgres://x',
  PUBLIC_BASE_URL: 'https://retro.example.com/',
  OWNER_SECRET: 'owner-secret-1234567',
  INVITE_CODES: 'a',
  SESSION_SECRET: 's'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ATLASSIAN_CLIENT_ID: 'cid',
  ATLASSIAN_CLIENT_SECRET: 'csecret',
});

let db: Db;
let nowMs = 1_000_000;
const now = () => nowMs;
const site = { id: 'cloud-1', url: 'https://x.atlassian.net', name: 'X' };

beforeEach(async () => {
  db = await createTestDb();
  nowMs = 1_000_000;
});

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

test('buildAuthorizeUrl contains required params', () => {
  const u = new URL(buildAuthorizeUrl(config, 'st'));
  expect(u.origin + u.pathname).toBe('https://auth.atlassian.com/authorize');
  expect(u.searchParams.get('audience')).toBe('api.atlassian.com');
  expect(u.searchParams.get('client_id')).toBe('cid');
  expect(u.searchParams.get('response_type')).toBe('code');
  expect(u.searchParams.get('prompt')).toBe('consent');
  expect(u.searchParams.get('state')).toBe('st');
  expect(u.searchParams.get('redirect_uri')).toBe('https://retro.example.com/api/settings/atlassian/callback');
  expect(u.searchParams.get('scope')).toBe(
    'read:space:confluence read:page:confluence write:page:confluence offline_access',
  );
});

test('exchangeCode computes expiresAt from deps.now', async () => {
  const f = (async () => json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 })) as typeof fetch;
  const t = await exchangeCode({ config, fetch: f, now }, 'code');
  expect(t).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(nowMs + 3_600_000) });
});

test('getAccessToken returns stored token when far from expiry', async () => {
  await saveTokens(db, config.encryptionKey, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: new Date(nowMs + 600_000) });
  await setSite(db, site);
  const f = (async () => {
    throw new Error('should not fetch');
  }) as typeof fetch;
  expect(await getAccessToken({ db, config, fetch: f, now })).toEqual({
    token: 'at-1',
    cloudId: 'cloud-1',
    siteUrl: site.url,
  });
});

test('getAccessToken refreshes near expiry and persists rotated refresh token', async () => {
  await saveTokens(db, config.encryptionKey, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: new Date(nowMs + 30_000) });
  await setSite(db, site);
  let sent: Record<string, string> = {};
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
  }) as unknown as typeof fetch;
  const r = await getAccessToken({ db, config, fetch: f, now });
  expect(r.token).toBe('at-2');
  expect(sent.grant_type).toBe('refresh_token');
  expect(sent.refresh_token).toBe('rt-1');
  const [row] = await db.select().from(atlassianConnection).where(eq(atlassianConnection.id, 1));
  expect(decrypt(row!.refreshTokenEnc, config.encryptionKey)).toBe('rt-2');
  expect(decrypt(row!.accessTokenEnc, config.encryptionKey)).toBe('at-2');
  expect(row!.expiresAt.getTime()).toBe(nowMs + 3_600_000);
  expect(row!.cloudId).toBe('cloud-1');
});

test('getAccessToken failing refresh throws reconnect message', async () => {
  await saveTokens(db, config.encryptionKey, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: new Date(nowMs) });
  await setSite(db, site);
  const f = (async () => json(403, { error: 'invalid_grant' })) as typeof fetch;
  const err = await getAccessToken({ db, config, fetch: f, now }).catch((e) => e);
  expect(err).toBeInstanceOf(DomainError);
  expect(err.code).toBe('forbidden');
  expect(err.message).toBe('Atlassian connection expired — owner needs to reconnect in Settings');
});

test('getAccessToken throws reconnect message when not connected', async () => {
  const err = await getAccessToken({ db, config, fetch, now }).catch((e) => e);
  expect(err.message).toBe('Atlassian connection expired — owner needs to reconnect in Settings');
});
