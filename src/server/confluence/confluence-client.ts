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

type PageResponse = { id: string; status?: string; title?: string; version: { number: number }; _links: { webui: string } };

function pageResult(c: ClientCtx, p: PageResponse): { id: string; version: number; url: string } {
  return { id: p.id, version: p.version.number, url: `${c.siteUrl.replace(/\/$/, '')}/wiki${p._links.webui}` };
}

const MAX_SPACE_PAGES = 20;

/** Current global spaces, following `_links.next` cursors (up to 20 pages), filtered by name. */
export async function listSpaces(c: ClientCtx, query?: string): Promise<{ id: string; key: string; name: string }[]> {
  type SpacesPage = { results: { id: string | number; key: string; name: string }[]; _links?: { next?: string } };
  const all: SpacesPage['results'] = [];
  let path: string | undefined = '/spaces?type=global&status=current&limit=250';
  for (let i = 0; path && i < MAX_SPACE_PAGES; i++) {
    const res = await request(c, 'GET', path);
    await ensureOk(res);
    const json = (await res.json()) as SpacesPage;
    all.push(...json.results);
    // `next` is site-relative (e.g. "/wiki/api/v2/spaces?cursor=…"); keep only the part after the API base.
    path = json._links?.next?.replace(/^.*?\/api\/v2/, '');
  }
  const q = query?.trim().toLowerCase();
  return all
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .map((s) => ({ id: String(s.id), key: s.key, name: s.name }));
}

export async function searchPages(c: ClientCtx, spaceId: string, title: string): Promise<{ id: string; title: string }[]> {
  const res = await request(c, 'GET', `/spaces/${enc(spaceId)}/pages?limit=25${title ? `&title=${enc(title)}` : ''}`);
  await ensureOk(res);
  const json = (await res.json()) as { results: { id: string; title: string }[] };
  return json.results.map((p) => ({ id: p.id, title: p.title }));
}

/** The current page, or null when it was deleted, trashed or archived. */
export async function getPage(c: ClientCtx, id: string): Promise<{ id: string; version: number; title: string } | null> {
  const res = await request(c, 'GET', `/pages/${enc(id)}`);
  if (res.status === 404) return null;
  await ensureOk(res);
  const p = (await res.json()) as PageResponse;
  if (p.status !== 'current') return null; // trashed/archived pages count as deleted
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
