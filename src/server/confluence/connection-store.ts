import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { atlassianConnection } from '../db/schema';
import { DomainError } from '../errors';
import { decrypt, encrypt } from '../security/crypto';
import { AtlassianHttpError, refreshTokens, type OAuthDeps, type Site, type Tokens } from './oauth';

export type Defaults = {
  spaceId: string;
  spaceName: string;
  parentId: string | null;
  parentTitle: string | null;
};

export type ConnectionInfo = { connected: boolean; site: Site | null; defaults: Defaults | null };

const ROW_ID = 1;
export const RECONNECT_MSG = 'Atlassian connection expired — owner needs to reconnect in Settings';

async function getRow(db: Db) {
  const [row] = await db.select().from(atlassianConnection).where(eq(atlassianConnection.id, ROW_ID));
  return row ?? null;
}

export async function saveTokens(db: Db, key: Buffer, tokens: Tokens, nowMs: number): Promise<void> {
  const values = {
    accessTokenEnc: encrypt(tokens.accessToken, key),
    refreshTokenEnc: encrypt(tokens.refreshToken, key),
    expiresAt: tokens.expiresAt,
    updatedAt: new Date(nowMs),
  };
  await db
    .insert(atlassianConnection)
    .values({ id: ROW_ID, ...values })
    .onConflictDoUpdate({ target: atlassianConnection.id, set: values });
}

/** Sets (or with null clears) the chosen site. No-op when there is no connection row. */
export async function setSite(db: Db, site: Site | null, nowMs: number): Promise<void> {
  await db
    .update(atlassianConnection)
    .set({
      cloudId: site?.id ?? null,
      siteUrl: site?.url ?? null,
      siteName: site?.name ?? null,
      updatedAt: new Date(nowMs),
    })
    .where(eq(atlassianConnection.id, ROW_ID));
}

/** Returns false when there is no connection row to attach defaults to. */
export async function setDefaults(db: Db, d: Defaults, nowMs: number): Promise<boolean> {
  const rows = await db
    .update(atlassianConnection)
    .set({
      defaultSpaceId: d.spaceId,
      defaultSpaceName: d.spaceName,
      defaultParentId: d.parentId,
      defaultParentTitle: d.parentTitle,
      updatedAt: new Date(nowMs),
    })
    .where(eq(atlassianConnection.id, ROW_ID))
    .returning({ id: atlassianConnection.id });
  return rows.length > 0;
}

export async function disconnect(db: Db): Promise<void> {
  await db.delete(atlassianConnection).where(eq(atlassianConnection.id, ROW_ID));
}

export async function getDefaults(db: Db): Promise<Defaults | null> {
  const row = await getRow(db);
  if (!row?.defaultSpaceId || !row.defaultSpaceName) return null;
  return {
    spaceId: row.defaultSpaceId,
    spaceName: row.defaultSpaceName,
    parentId: row.defaultParentId,
    parentTitle: row.defaultParentTitle,
  };
}

export async function getConnectionInfo(db: Db): Promise<ConnectionInfo> {
  const row = await getRow(db);
  if (!row) return { connected: false, site: null, defaults: null };
  const site =
    row.cloudId && row.siteUrl ? { id: row.cloudId, url: row.siteUrl, name: row.siteName ?? row.siteUrl } : null;
  return { connected: true, site, defaults: await getDefaults(db) };
}

/** Tokens and a chosen site are both present. */
export async function isConnected(db: Db): Promise<boolean> {
  const row = await getRow(db);
  return !!row && !!row.cloudId && !!row.siteUrl;
}

type TokenDeps = Pick<OAuthDeps, 'config' | 'fetch' | 'now'> & { db: Db };

/** Valid access token for the stored connection (site not required); refreshes near expiry. */
const inflight = new WeakMap<Db, Promise<string>>();

export function getValidToken(deps: TokenDeps): Promise<string> {
  const existing = inflight.get(deps.db);
  if (existing) return existing;
  const p = loadValidToken(deps).finally(() => inflight.delete(deps.db));
  inflight.set(deps.db, p);
  return p;
}

async function loadValidToken(deps: TokenDeps): Promise<string> {
  const { db, config } = deps;
  const row = await getRow(db);
  if (!row) throw new DomainError('forbidden', RECONNECT_MSG);
  if (row.expiresAt.getTime() - deps.now() >= 60_000) return decrypt(row.accessTokenEnc, config.encryptionKey);
  try {
    const fresh = await refreshTokens(deps, decrypt(row.refreshTokenEnc, config.encryptionKey));
    await saveTokens(db, config.encryptionKey, fresh, deps.now());
    return fresh.accessToken;
  } catch (err) {
    if (err instanceof AtlassianHttpError && err.status >= 400 && err.status < 500) {
      throw new DomainError('forbidden', RECONNECT_MSG);
    }
    throw err;
  }
}

export async function getAccessToken(deps: TokenDeps): Promise<{ token: string; cloudId: string; siteUrl: string }> {
  const row = await getRow(deps.db);
  if (!row || !row.cloudId || !row.siteUrl) throw new DomainError('forbidden', RECONNECT_MSG);
  const token = await getValidToken(deps);
  return { token, cloudId: row.cloudId, siteUrl: row.siteUrl };
}
