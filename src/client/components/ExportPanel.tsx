import { useEffect, useRef, useState } from 'react';
import type { ExportView } from '../../shared/types';

const DEBOUNCE_MS = 300;
const NOT_CONNECTED = "Confluence isn't connected. The owner can connect it in Settings.";

type Space = { id: string; key: string; name: string };
type Page = { id: string; title: string };
type Mode = 'auto' | 'overwrite' | 'new';

async function failureMessage(res: Response): Promise<string> {
  let body: { error?: string; message?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 409 && body.error === 'not_connected') return NOT_CONNECTED;
  if (res.status === 403) return body.message ?? 'Admin access is required.';
  if (res.status === 404) return 'Board not found.';
  return body.message ?? `Request failed (${res.status}).`;
}

/** Runs `load` after a debounce (immediately on first run); ignores stale results. */
function useDebouncedSearch<T>(
  q: string,
  enabled: boolean,
  load: (q: string) => Promise<T[]>,
  onError: (m: string) => void,
  resetKey: string,
): T[] {
  const [results, setResults] = useState<T[]>([]);
  const first = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const errRef = useRef(onError);
  errRef.current = onError;

  useEffect(() => {
    first.current = true;
  }, [resetKey]);

  useEffect(() => {
    if (!enabled) {
      setResults([]);
      return;
    }
    let stale = false;
    const delay = first.current ? 0 : DEBOUNCE_MS;
    first.current = false;
    const t = setTimeout(() => {
      loadRef
        .current(q)
        .then((r) => {
          if (!stale) setResults(r);
        })
        .catch((e: Error) => {
          if (!stale) errRef.current(e.message);
        });
    }, delay);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, enabled, resetKey]);

  return results;
}

export type ExportPanelProps = { boardId: string; adminToken: string | undefined; exportView: ExportView | null };

export function ExportPanel({ boardId, adminToken, exportView }: ExportPanelProps) {
  const [spaceQuery, setSpaceQuery] = useState('');
  const [spaceId, setSpaceId] = useState(exportView?.spaceId ?? '');
  const [spaceName, setSpaceName] = useState(exportView?.spaceName ?? '');
  const [pageQuery, setPageQuery] = useState('');
  const [parentId, setParentId] = useState(exportView?.parentId ?? '');
  const [parentTitle, setParentTitle] = useState(exportView?.parentTitle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = `/api/boards/${encodeURIComponent(boardId)}`;
  const headers: Record<string, string> = { 'x-admin-token': adminToken ?? '' };

  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(await failureMessage(res));
    return res;
  };

  const connected = exportView !== null && exportView.status !== 'not_connected';
  const spaces = useDebouncedSearch<Space>(
    spaceQuery,
    connected,
    async (q) => ((await (await call(`/confluence/spaces?q=${encodeURIComponent(q)}`)).json()) as { spaces?: Space[] }).spaces ?? [],
    setError,
    boardId,
  );
  const pages = useDebouncedSearch<Page>(
    pageQuery,
    connected && spaceId !== '',
    async (q) =>
      ((await (await call(`/confluence/pages?spaceId=${encodeURIComponent(spaceId)}&q=${encodeURIComponent(q)}`)).json()) as { pages?: Page[] }).pages ?? [],
    setError,
    spaceId,
  );

  if (!exportView) return null;

  const guarded = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const saveTarget = () =>
    guarded(() =>
      call('/export-target', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          spaceId,
          spaceName,
          parentId: parentId || null,
          parentTitle: parentId ? parentTitle : null,
        }),
      }),
    );

  const startExport = (mode: Mode) =>
    guarded(() =>
      call('/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }),
    );

  const { status } = exportView;

  if (status === 'not_connected') {
    return (
      <section className="card stack" aria-label="Export">
        <h2>Export</h2>
        <p>{NOT_CONNECTED}</p>
      </section>
    );
  }

  // Keep the chosen space selectable even when the current search no longer lists it.
  const spaceOptions = spaces.some((s) => s.id === spaceId) || !spaceId ? spaces : [{ id: spaceId, key: '', name: spaceName }, ...spaces];
  const pageOptions = pages.some((p) => p.id === parentId) || !parentId ? pages : [{ id: parentId, title: parentTitle }, ...pages];
  const hasTarget = exportView.spaceId !== null;

  return (
    <section className="card stack" aria-label="Export">
      <h2>Export to Confluence</h2>

      {hasTarget && (
        <p>
          Saved target: <strong>{exportView.spaceName}</strong>
          {exportView.parentTitle ? <> / {exportView.parentTitle}</> : null}
        </p>
      )}

      <label className="field">
        <span>Search spaces</span>
        <input value={spaceQuery} onChange={(e) => setSpaceQuery(e.target.value)} />
      </label>
      <label className="field">
        <span>Space</span>
        <select
          value={spaceId}
          onChange={(e) => {
            const s = spaceOptions.find((o) => o.id === e.target.value);
            setSpaceId(s?.id ?? '');
            setSpaceName(s?.name ?? '');
            setParentId('');
            setParentTitle('');
            setPageQuery('');
          }}
        >
          <option value="">Choose a space</option>
          {spaceOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      {spaceId && (
        <>
          <label className="field">
            <span>Search parent pages (optional)</span>
            <input value={pageQuery} onChange={(e) => setPageQuery(e.target.value)} />
          </label>
          <label className="field">
            <span>Parent page</span>
            <select
              value={parentId}
              onChange={(e) => {
                const p = pageOptions.find((o) => o.id === e.target.value);
                setParentId(p?.id ?? '');
                setParentTitle(p?.title ?? '');
              }}
            >
              <option value="">Top of space</option>
              {pageOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      <div>
        <button type="button" className="btn btn-secondary" disabled={!spaceId || busy} onClick={saveTarget}>
          Save target
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {status === 'pending' && (
        <p role="status" className="export-pending">
          <span className="spinner" aria-hidden="true" /> Exporting…{' '}
          <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => startExport('auto')}>
            Try again
          </button>
        </p>
      )}

      {status === 'success' && exportView.pageUrl && (
        <p role="status">
          Exported:{' '}
          <a href={exportView.pageUrl} target="_blank" rel="noopener noreferrer">
            Open the Confluence page
          </a>
        </p>
      )}

      {status === 'conflict' && (
        <div role="status" className="stack">
          <p>{exportView.error ?? 'A page with this title already exists.'}</p>
          <div className="inline-form">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => startExport('overwrite')}>
              Overwrite
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => startExport('new')}>
              Create new page
            </button>
          </div>
        </div>
      )}

      {status === 'failed' && (
        <div role="status" className="stack">
          <p className="error">{exportView.error ?? 'Export failed.'}</p>
          <div>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => startExport('auto')}>
              Try again
            </button>
          </div>
        </div>
      )}

      {(status === 'idle' || status === 'success') && (
        <div>
          <button type="button" className="btn btn-primary" disabled={!hasTarget || busy} onClick={() => startExport('auto')}>
            {status === 'success' ? 'Export again' : 'Export to Confluence'}
          </button>
          {!hasTarget && <p className="muted">Save a target space first.</p>}
        </div>
      )}
    </section>
  );
}
