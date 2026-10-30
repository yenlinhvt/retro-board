export type ClientCtx = { fetch: typeof fetch; token: string; cloudId: string; siteUrl: string };

/** Thrown on a non-2xx Confluence response; `message` carries the (truncated) response body. */
export class ConfluenceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ConfluenceError';
  }
}

const enc = encodeURIComponent;

async function request(c: ClientCtx, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${c.token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await c.fetch(`https://api.atlassian.com/ex/confluence/${enc(c.cloudId)}/wiki/api/v2${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const text = (await res.text().catch(() => '')).slice(0, 500);
  throw new ConfluenceError(res.status, text || `Confluence request failed (${res.status})`);
}

type PageResponse = { id: string; title?: string; version: { number: number }; _links: { webui: string } };

function pageResult(c: ClientCtx, p: PageResponse): { id: string; version: number; url: string } {
  return { id: p.id, version: p.version.number, url: `${c.siteUrl.replace(/\/$/, '')}/wiki${p._links.webui}` };
}

export async function listSpaces(c: ClientCtx, query?: string): Promise<{ id: string; key: string; name: string }[]> {
  const res = await request(c, 'GET', '/spaces?limit=250');
  await ensureOk(res);
  const json = (await res.json()) as { results: { id: string | number; key: string; name: string }[] };
  const q = query?.trim().toLowerCase();
  return json.results
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .map((s) => ({ id: String(s.id), key: s.key, name: s.name }));
}

export async function searchPages(c: ClientCtx, spaceId: string, title: string): Promise<{ id: string; title: string }[]> {
  const res = await request(c, 'GET', `/spaces/${enc(spaceId)}/pages?limit=25${title ? `&title=${enc(title)}` : ''}`);
  await ensureOk(res);
  const json = (await res.json()) as { results: { id: string; title: string }[] };
  return json.results.map((p) => ({ id: p.id, title: p.title }));
}

export async function getPage(c: ClientCtx, id: string): Promise<{ id: string; version: number; title: string } | null> {
  const res = await request(c, 'GET', `/pages/${enc(id)}`);
  if (res.status === 404) return null;
  await ensureOk(res);
  const p = (await res.json()) as PageResponse;
  return { id: p.id, version: p.version.number, title: p.title ?? '' };
}

export async function createPage(
  c: ClientCtx,
  a: { spaceId: string; parentId: string | null; title: string; storage: string },
): Promise<{ id: string; version: number; url: string }> {
  const res = await request(c, 'POST', '/pages', {
    spaceId: a.spaceId,
    status: 'current',
    title: a.title,
    ...(a.parentId ? { parentId: a.parentId } : {}),
    body: { representation: 'storage', value: a.storage },
  });
  await ensureOk(res);
  return pageResult(c, (await res.json()) as PageResponse);
}

export async function updatePage(
  c: ClientCtx,
  a: { id: string; title: string; storage: string; version: number },
): Promise<{ id: string; version: number; url: string }> {
  const res = await request(c, 'PUT', `/pages/${enc(a.id)}`, {
    id: a.id,
    status: 'current',
    title: a.title,
    body: { representation: 'storage', value: a.storage },
    version: { number: a.version },
  });
  await ensureOk(res);
  return pageResult(c, (await res.json()) as PageResponse);
}
