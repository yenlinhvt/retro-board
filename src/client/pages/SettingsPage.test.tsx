import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
let handlers: Handler[];
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

const SITE = { id: 'c1', url: 'https://x.atlassian.net', name: 'Acme' };
const settings = (o: object = {}) => ({ connected: false, site: null, defaults: null, atlassianConfigured: true, ...o });

beforeEach(() => {
  handlers = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    return json({ error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const when = (method: string, path: string, res: () => Response): Handler => (url, init) =>
  (init?.method ?? 'GET') === method && url === path ? res() : undefined;
const whenStarts = (method: string, prefix: string, res: () => Response): Handler => (url, init) =>
  (init?.method ?? 'GET') === method && url.startsWith(prefix) ? res() : undefined;
const calls = (method: string, path: string) =>
  fetchMock.mock.calls.filter(([u, i]) => u === path && (i?.method ?? 'GET') === method);

function Loc() {
  const l = useLocation();
  return <output data-testid="loc">{l.pathname + l.search}</output>;
}
async function renderAt(url = '/settings') {
  render(
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SettingsPage />
      <Loc />
    </MemoryRouter>,
  );
  await act(async () => {});
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

test('401 shows the login form; a wrong secret says "Wrong secret"', async () => {
  handlers.push(when('GET', '/api/settings', () => json({ error: 'unauthorized' }, 401)));
  handlers.push(when('POST', '/api/settings/login', () => json({ error: 'unauthorized' }, 401)));
  await renderAt();
  const field = screen.getByLabelText('Owner secret') as HTMLInputElement;
  expect(field.type).toBe('password');
  type(field, 'nope');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); });
  expect(screen.getByRole('alert').textContent).toBe('Wrong secret');
  expect(JSON.parse(String(calls('POST', '/api/settings/login')[0]![1]!.body))).toEqual({ secret: 'nope' });
});

test('429 on login shows the rate limit message', async () => {
  handlers.push(when('GET', '/api/settings', () => json({ error: 'unauthorized' }, 401)));
  handlers.push(when('POST', '/api/settings/login', () => json({ statusCode: 429, error: 'Too Many Requests' }, 429)));
  await renderAt();
  type(screen.getByLabelText('Owner secret'), 'x');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); });
  expect(screen.getByRole('alert').textContent).toBe('Too many attempts — try again in a minute.');
});

test('a correct secret loads the settings', async () => {
  let loggedIn = false;
  handlers.push(when('POST', '/api/settings/login', () => { loggedIn = true; return json({ ok: true }); }));
  handlers.push((u, i) => (u === '/api/settings' && !i?.method ? (loggedIn ? json(settings()) : json({ error: 'unauthorized' }, 401)) : undefined));
  await renderAt();
  type(screen.getByLabelText('Owner secret'), 'right');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); });
  expect(screen.getByRole('link', { name: 'Connect with Atlassian' })).toBeTruthy();
});

test('not configured explains the env vars and links to the README', async () => {
  handlers.push(when('GET', '/api/settings', () => json(settings({ atlassianConfigured: false }))));
  await renderAt();
  expect(screen.getByText('ATLASSIAN_CLIENT_ID')).toBeTruthy();
  expect(screen.getByText('ATLASSIAN_CLIENT_SECRET')).toBeTruthy();
  expect(screen.getByText(/“Confluence export” section of the README/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: /README/ })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Connect with Atlassian' })).toBeNull();
});

test('not connected shows a plain link to the connect route', async () => {
  handlers.push(when('GET', '/api/settings', () => json(settings())));
  await renderAt();
  const a = screen.getByRole('link', { name: 'Connect with Atlassian' }) as HTMLAnchorElement;
  expect(a.getAttribute('href')).toBe('/api/settings/atlassian/connect');
});

test('?error= shows a readable message and is stripped from the URL', async () => {
  handlers.push(when('GET', '/api/settings', () => json(settings())));
  await renderAt('/settings?error=atlassian_denied');
  expect(screen.getByRole('alert').textContent).toMatch(/not granted/i);
  expect(screen.getByTestId('loc').textContent).toBe('/settings');
});

test('connected with tokens but no site shows the site picker and saves the choice', async () => {
  let site: typeof SITE | null = null;
  handlers.push((u, i) => (u === '/api/settings' && !i?.method ? json(settings({ connected: true, site })) : undefined));
  handlers.push(when('GET', '/api/settings/atlassian/sites', () => json({ sites: [SITE, { id: 'c2', url: 'https://y.atlassian.net', name: 'Other' }] })));
  handlers.push(when('PUT', '/api/settings/atlassian/site', () => { site = SITE; return json({ ok: true }); }));
  handlers.push(whenStarts('GET', '/api/settings/confluence/', () => json({ spaces: [], pages: [] })));
  await renderAt();
  const picker = screen.getByLabelText('Confluence site') as HTMLSelectElement;
  type(picker, 'c1');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save site' })); });
  expect(JSON.parse(String(calls('PUT', '/api/settings/atlassian/site')[0]![1]!.body))).toEqual({ id: 'c1' });
  expect(screen.getByText('Acme', { selector: 'strong' })).toBeTruthy();
});

test('connected shows the site, Disconnect confirms first, then returns to Connect', async () => {
  let connected = true;
  handlers.push((u, i) =>
    u === '/api/settings' && !i?.method ? json(settings(connected ? { connected: true, site: SITE } : {})) : undefined);
  handlers.push(when('GET', '/api/settings/atlassian/sites', () => json({ sites: [SITE] })));
  handlers.push(whenStarts('GET', '/api/settings/confluence/', () => json({ spaces: [], pages: [] })));
  handlers.push(when('POST', '/api/settings/atlassian/disconnect', () => { connected = false; return json({ ok: true }); }));
  await renderAt();
  expect(screen.getByText('Acme', { selector: 'strong' })).toBeTruthy();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
  expect(calls('POST', '/api/settings/atlassian/disconnect')).toHaveLength(0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(calls('POST', '/api/settings/atlassian/disconnect')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Connect with Atlassian' })).toBeTruthy();
});

test('default space and parent are searched through the settings routes and saved', async () => {
  handlers.push(when('GET', '/api/settings', () => json(settings({ connected: true, site: SITE }))));
  handlers.push(when('GET', '/api/settings/atlassian/sites', () => json({ sites: [SITE] })));
  handlers.push(whenStarts('GET', '/api/settings/confluence/spaces', () => json({ spaces: [{ id: 's1', key: 'T', name: 'Team' }, { id: 's2', key: 'D', name: 'Docs' }] })));
  handlers.push(whenStarts('GET', '/api/settings/confluence/pages', () => json({ pages: [{ id: 'p1', title: 'Retros' }] })));
  handlers.push(when('PUT', '/api/settings/defaults', () => json({ ok: true })));
  await renderAt();
  await waitFor(() => expect(screen.getByRole('option', { name: 'Docs' })).toBeTruthy());
  type(screen.getByLabelText('Space'), 's2');
  await waitFor(() => expect(screen.getByRole('option', { name: 'Retros' })).toBeTruthy());
  expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/settings/confluence/pages?spaceId=s2&q='))).toBe(true);
  type(screen.getByLabelText('Parent page'), 'p1');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save defaults' })); });
  expect(JSON.parse(String(calls('PUT', '/api/settings/defaults')[0]![1]!.body))).toEqual({
    spaceId: 's2', spaceName: 'Docs', parentId: 'p1', parentTitle: 'Retros',
  });
  expect(screen.getByText('Defaults saved.')).toBeTruthy();
});

test('a reconnect (403) from the space search is shown', async () => {
  handlers.push(when('GET', '/api/settings', () => json(settings({ connected: true, site: SITE }))));
  handlers.push(when('GET', '/api/settings/atlassian/sites', () => json({ sites: [SITE] })));
  handlers.push(whenStarts('GET', '/api/settings/confluence/spaces', () => json({ error: 'forbidden', message: 'Atlassian connection expired — owner needs to reconnect in Settings' }, 403)));
  await renderAt();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('needs to reconnect'));
});

test('Log out posts and returns to the login form', async () => {
  let out = false;
  handlers.push((u, i) => (u === '/api/settings' && !i?.method ? (out ? json({ error: 'unauthorized' }, 401) : json(settings())) : undefined));
  handlers.push(when('POST', '/api/settings/logout', () => { out = true; return json({ ok: true }); }));
  await renderAt();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log out' })); });
  expect(calls('POST', '/api/settings/logout')).toHaveLength(1);
  expect(screen.getByLabelText('Owner secret')).toBeTruthy();
});

test('the ?error= notice is cleared after a successful login', async () => {
  let loggedIn = false;
  handlers.push(when('POST', '/api/settings/login', () => { loggedIn = true; return json({ ok: true }); }));
  handlers.push((u, i) => (u === '/api/settings' && !i?.method ? (loggedIn ? json(settings()) : json({ error: 'unauthorized' }, 401)) : undefined));
  await renderAt('/settings?error=atlassian_failed');
  expect(screen.getByRole('alert').textContent).toMatch(/failed/i);
  type(screen.getByLabelText('Owner secret'), 'right');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in' })); });
  expect(screen.queryByRole('alert')).toBeNull();
});
