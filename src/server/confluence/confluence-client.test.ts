import { describe, expect, test, vi } from 'vitest';
import {
  ConfluenceError, createPage, getPage, listSpaces, searchPages, updatePage, type ClientCtx,
} from './confluence-client';

const BASE = 'https://api.atlassian.com/ex/confluence/cid/wiki/api/v2';

function ctx(res: { status?: number; body?: unknown; text?: string }) {
  const fetch = vi.fn(async () =>
    new Response(res.text ?? JSON.stringify(res.body ?? {}), { status: res.status ?? 200 }),
  );
  const c: ClientCtx = { fetch: fetch as unknown as typeof globalThis.fetch, token: 'tok', cloudId: 'cid', siteUrl: 'https://x.atlassian.net/' };
  return { c, fetch };
}

describe('confluence client', () => {
  test('createPage posts v2 payload and builds url', async () => {
    const { c, fetch } = ctx({ body: { id: '9', version: { number: 1 }, _links: { webui: '/spaces/S/pages/9' } } });
    const out = await createPage(c, { spaceId: '1', parentId: null, title: 'T', storage: '<p>x</p>' });
    expect(out).toEqual({ id: '9', version: 1, url: 'https://x.atlassian.net/wiki/spaces/S/pages/9' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/pages`);
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h.Accept).toBe('application/json');
    expect(h['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      spaceId: '1', status: 'current', title: 'T', body: { representation: 'storage', value: '<p>x</p>' },
    });
  });

  test('createPage includes parentId when given', async () => {
    const { c, fetch } = ctx({ body: { id: '9', version: { number: 1 }, _links: { webui: '/p' } } });
    await createPage(c, { spaceId: '1', parentId: '5', title: 'T', storage: 's' });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).parentId).toBe('5');
  });

  test('updatePage puts version number', async () => {
    const { c, fetch } = ctx({ body: { id: '9', version: { number: 4 }, _links: { webui: '/p' } } });
    const out = await updatePage(c, { id: '9', title: 'T', storage: 's', version: 4 });
    expect(out.version).toBe(4);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/pages/9`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      id: '9', status: 'current', title: 'T', body: { representation: 'storage', value: 's' }, version: { number: 4 },
    });
  });

  test('getPage returns null on 404; non-2xx throws ConfluenceError with status', async () => {
    expect(await getPage(ctx({ status: 404, text: 'nope' }).c, '1')).toBeNull();
    const ok = await getPage(ctx({ body: { id: '1', title: 'T', version: { number: 3 } } }).c, '1');
    expect(ok).toEqual({ id: '1', title: 'T', version: 3 });
    const err = await getPage(ctx({ status: 500, text: 'boom' }).c, '1').catch((e) => e);
    expect(err).toBeInstanceOf(ConfluenceError);
    expect(err.status).toBe(500);
    expect(err.message).toContain('boom');
  });

  test('error message truncates body to 500 chars', async () => {
    const err = await createPage(ctx({ status: 400, text: 'a'.repeat(900) }).c, { spaceId: '1', parentId: null, title: 'T', storage: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfluenceError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('a'.repeat(500));
    expect(err.message).not.toContain('a'.repeat(501));
  });

  test('listSpaces filters by name case-insensitively and stringifies id', async () => {
    const { c, fetch } = ctx({ body: { results: [{ id: 1, key: 'ENG', name: 'Engineering' }, { id: '2', key: 'HR', name: 'People' }] } });
    expect(await listSpaces(c, 'eNg')).toEqual([{ id: '1', key: 'ENG', name: 'Engineering' }]);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/spaces?limit=250`);
    expect(await listSpaces(c)).toHaveLength(2);
  });

  test('searchPages encodes values and omits empty title', async () => {
    const a = ctx({ body: { results: [{ id: '3', title: 'A b', extra: 1 }] } });
    expect(await searchPages(a.c, 's/1', 'A&b')).toEqual([{ id: '3', title: 'A b' }]);
    expect((a.fetch.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/spaces/s%2F1/pages?limit=25&title=A%26b`);
    const b = ctx({ body: { results: [] } });
    await searchPages(b.c, '1', '');
    expect((b.fetch.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/spaces/1/pages?limit=25`);
  });
});
