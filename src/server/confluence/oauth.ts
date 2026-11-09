import type { Config } from '../config';

export const AUTH_URL = 'https://auth.atlassian.com/authorize';
export const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
export const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
export const SCOPES = ['read:space:confluence', 'read:page:confluence', 'write:page:confluence', 'offline_access'];

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: Date };
export type Site = { id: string; url: string; name: string };
export type OAuthDeps = { config: Config; fetch: typeof fetch; now: () => number };

/** Thrown when Atlassian answers a token request with a non-2xx status. */
export class AtlassianHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'AtlassianHttpError';
  }
}

function atlassianOf(config: Pick<Config, 'atlassian'>): { clientId: string; clientSecret: string } {
  if (!config.atlassian) throw new Error('Atlassian is not configured');
  return config.atlassian;
}

export function redirectUri(config: Pick<Config, 'publicBaseUrl'>): string {
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/api/settings/atlassian/callback`;
}

export function buildAuthorizeUrl(cfg: Pick<Config, 'publicBaseUrl' | 'atlassian'>, state: string): string {
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: atlassianOf(cfg).clientId,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri(cfg),
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(deps: OAuthDeps, body: Record<string, string>, fallbackRefresh?: string): Promise<Tokens> {
  const { clientId, clientSecret } = atlassianOf(deps.config);
  const res = await deps.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new AtlassianHttpError(res.status, `Atlassian token request failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  const refreshToken = json.refresh_token ?? fallbackRefresh;
  if (!json.access_token || !refreshToken || typeof json.expires_in !== 'number') {
    throw new Error('Atlassian token response was malformed');
  }
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: new Date(deps.now() + json.expires_in * 1000),
  };
}

export function exchangeCode(deps: OAuthDeps, code: string): Promise<Tokens> {
  return tokenRequest(deps, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(deps.config),
  });
}

export function refreshTokens(deps: OAuthDeps, refreshToken: string): Promise<Tokens> {
  return tokenRequest(deps, { grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
}

export async function listSites(deps: Pick<OAuthDeps, 'fetch'>, accessToken: string): Promise<Site[]> {
  const res = await deps.fetch(RESOURCES_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) throw new AtlassianHttpError(res.status, `Atlassian site lookup failed (${res.status})`);
  const json = (await res.json()) as { id: string; url: string; name: string }[];
  return json.map((s) => ({ id: s.id, url: s.url, name: s.name }));
}
