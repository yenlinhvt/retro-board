import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ExportPanel } from './ExportPanel';
import type { ExportView } from '../../shared/types';

const view = (o: Partial<ExportView> = {}): ExportView => ({
  status: 'idle', pageUrl: null, error: null, spaceId: 's1', spaceName: 'Team', parentId: null, parentTitle: null, ...o,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: any) => Promise<Response>>>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string, _init?: any) => {
    if (url.includes('/confluence/spaces')) return json([{ id: 's1', key: 'T', name: 'Team' }, { id: 's2', key: 'D', name: 'Docs' }]);
    if (url.includes('/confluence/pages')) return json([{ id: 'p1', title: 'Retros' }]);
    return json({}, 202);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const exportCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/export')) as [string, any][];

test('ExportPanel conflict shows Overwrite and Create new page and posts mode', async () => {
  render(<ExportPanel boardId="b1" adminToken="tok" exportView={view({ status: 'conflict', error: 'Page exists' })} />);
  expect(screen.getByText('Page exists')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Overwrite' })); });
  let [url, init] = exportCalls()[0]!;
  expect(url).toBe('/api/boards/b1/export');
  expect(JSON.parse(init.body)).toEqual({ mode: 'overwrite' });
  expect(init.headers['x-admin-token']).toBe('tok');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create new page' })); });
  [url, init] = exportCalls()[1]!;
  expect(JSON.parse(init.body)).toEqual({ mode: 'new' });
});

test('ExportPanel success shows page link', () => {
  render(<ExportPanel boardId="b1" adminToken="tok" exportView={view({ status: 'success', pageUrl: 'https://x.atlassian.net/wiki/p/1' })} />);
  const a = screen.getByRole('link') as HTMLAnchorElement;
  expect(a.href).toBe('https://x.atlassian.net/wiki/p/1');
  expect(screen.getByRole('button', { name: 'Export again' })).toBeTruthy();
});

test('not_connected shows the settings message and no controls', () => {
  render(<ExportPanel boardId="b1" adminToken="tok" exportView={view({ status: 'not_connected' })} />);
  expect(screen.getByText("Confluence isn't connected. The owner can connect it in Settings.")).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('pending shows spinner status and still offers Try again', async () => {
  render(<ExportPanel boardId="b1" adminToken="tok" exportView={view({ status: 'pending' })} />);
  expect(screen.getByText(/Exporting/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(JSON.parse(exportCalls()[0]![1].body)).toEqual({ mode: 'auto' });
});

test('failed shows error and Try again; saved target is displayed', () => {
  render(<ExportPanel boardId="b1" adminToken="tok" exportView={view({ status: 'failed', error: 'Boom', parentTitle: 'Retros' })} />);
  expect(screen.getByText('Boom')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.getByText('Team')).toBeTruthy();
  expect(screen.getByText(/Retros/)).toBeTruthy();
});

test('space search is debounced 300ms and Save target PUTs the chosen space and parent', async () => {
  vi.useFakeTimers();
  render(<ExportPanel boardId="b1" adminToken="tok" exportView={view({ spaceId: null, spaceName: null })} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const spaceCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/confluence/spaces'));
  expect(spaceCalls()).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Search spaces'), { target: { value: 'do' } });
  fireEvent.change(screen.getByLabelText('Search spaces'), { target: { value: 'doc' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(299); });
  expect(spaceCalls()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(spaceCalls()).toHaveLength(2);
  expect(String(spaceCalls()[1]![0])).toContain('q=doc');

  fireEvent.change(screen.getByLabelText('Space'), { target: { value: 's2' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  fireEvent.change(screen.getByLabelText('Parent page'), { target: { value: 'p1' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save target' })); });
  const put = fetchMock.mock.calls.find(([, i]) => i?.method === 'PUT')!;
  expect(put[0]).toBe('/api/boards/b1/export-target');
  expect(JSON.parse(put[1].body)).toEqual({ spaceId: 's2', spaceName: 'Docs', parentId: 'p1', parentTitle: 'Retros' });
});

test('403 on export shows the server message', async () => {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith('/export') ? json({ error: 'forbidden', message: 'Nope' }, 403) : json([]),
  );
  render(<ExportPanel boardId="b1" adminToken="bad" exportView={view()} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export to Confluence' })); });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Nope'));
});
