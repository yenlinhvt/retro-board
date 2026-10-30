import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebouncedSearch } from '../lib/useDebouncedSearch';

type Site = { id: string; url: string; name: string };
type Defaults = { spaceId: string; spaceName: string; parentId: string | null; parentTitle: string | null };
type Info = { connected: boolean; site: Site | null; defaults: Defaults | null; atlassianConfigured: boolean };
type Space = { id: string; key: string; name: string };
type Page = { id: string; title: string };

const OAUTH_ERRORS: Record<string, string> = {
  atlassian_denied: 'Atlassian access was not granted. Connect again and approve the request.',
  atlassian_failed: 'Connecting to Atlassian failed. Try again.',
  invalid_state: 'The Atlassian sign-in expired or was started elsewhere. Connect again.',
};

async function failureMessage(res: Response): Promise<string> {
  let body: { message?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return body.message ?? `Request failed (${res.status}).`;
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(await failureMessage(res));
  return (await res.json()) as T;
}

const post = (path: string) => api(path, { method: 'POST' });
const send = (method: string, path: string, body: unknown) =>
  api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      if (res.status === 401) setError('Wrong secret');
      else if (res.status === 429) setError('Too many attempts — try again in a minute.');
      else if (!res.ok) setError(await failureMessage(res));
      else onLoggedIn();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Owner login</h2>
      <label className="field">
        <span>Owner secret</span>
        <input type="password" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy || !secret}>
          Log in
        </button>
      </div>
    </form>
  );
}

function ConnectLink({ label }: { label: string }) {
  return (
    <a className="btn btn-primary" href="/api/settings/atlassian/connect">
      {label}
    </a>
  );
}

function Connected({ info, reload, onSuccess }: { info: Info; reload: () => Promise<void>; onSuccess: () => void }) {
  const { site, defaults } = info;
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(site?.id ?? '');
  const [spaceQuery, setSpaceQuery] = useState('');
  const [spaceId, setSpaceId] = useState(defaults?.spaceId ?? '');
  const [spaceName, setSpaceName] = useState(defaults?.spaceName ?? '');
  const [pageQuery, setPageQuery] = useState('');
  const [parentId, setParentId] = useState(defaults?.parentId ?? '');
  const [parentTitle, setParentTitle] = useState(defaults?.parentTitle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    api<{ sites: Site[] }>('/api/settings/atlassian/sites')
      .then((r) => {
        if (!stale) setSites(r.sites);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, []);

  const spaces = useDebouncedSearch<Space>(
    spaceQuery,
    site !== null,
    async (q) => (await api<{ spaces: Space[] }>(`/api/settings/confluence/spaces?q=${encodeURIComponent(q)}`)).spaces,
    setError,
    'spaces',
  );
  const pages = useDebouncedSearch<Page>(
    pageQuery,
    site !== null && spaceId !== '',
    async (q) =>
      (await api<{ pages: Page[] }>(`/api/settings/confluence/pages?spaceId=${encodeURIComponent(spaceId)}&q=${encodeURIComponent(q)}`)).pages,
    setError,
    spaceId,
  );

  const guarded = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await fn();
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const saveSite = () => guarded(async () => {
    await send('PUT', '/api/settings/atlassian/site', { id: siteId });
    await reload();
  });

  const saveDefaults = () => guarded(async () => {
    await send('PUT', '/api/settings/defaults', {
      spaceId,
      spaceName,
      parentId: parentId || null,
      parentTitle: parentId ? parentTitle : null,
    });
    setSaved(true);
  });

  const disconnect = () => {
    if (!window.confirm('Disconnect Atlassian? Boards will no longer be able to export to Confluence until you reconnect.')) return;
    void guarded(async () => {
      await post('/api/settings/atlassian/disconnect');
      await reload();
    });
  };

  // Keep the chosen values selectable even when the current search no longer lists them.
  const spaceOptions = !spaceId || spaces.some((s) => s.id === spaceId) ? spaces : [{ id: spaceId, key: '', name: spaceName }, ...spaces];
  const pageOptions = !parentId || pages.some((p) => p.id === parentId) ? pages : [{ id: parentId, title: parentTitle }, ...pages];
  const pickSite = site === null || sites.length > 1;

  return (
    <section className="card stack" aria-label="Atlassian connection">
      <h2>Atlassian</h2>
      {site ? (
        <p>
          Connected to <strong>{site.name}</strong>
        </p>
      ) : (
        <p>Connected. Choose the Confluence site to export to.</p>
      )}

      {pickSite && (
        <div className="inline-form">
          <label className="field">
            <span>Confluence site</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">Choose a site</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-secondary" disabled={!siteId || siteId === site?.id || busy} onClick={saveSite}>
            Save site
          </button>
        </div>
      )}

      {site && (
        <>
          <h3>Default export location</h3>
          <p className="muted">New boards export here unless the board admin picks another place.</p>
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
            <button type="button" className="btn btn-primary" disabled={!spaceId || busy} onClick={saveDefaults}>
              Save defaults
            </button>
          </div>
          {saved && <p role="status">Defaults saved.</p>}
        </>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="inline-form">
        <ConnectLink label="Reconnect" />
        <button type="button" className="btn btn-danger" disabled={busy} onClick={disconnect}>
          Disconnect
        </button>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const code = params.get('error');
    return code ? (OAUTH_ERRORS[code] ?? 'Something went wrong while connecting Atlassian.') : null;
  });

  useEffect(() => {
    if (params.has('error')) {
      const next = new URLSearchParams(params);
      next.delete('error');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.status === 401) {
        setNeedsLogin(true);
        setInfo(null);
      } else if (!res.ok) {
        setLoadError(await failureMessage(res));
      } else {
        setInfo((await res.json()) as Info);
        setNeedsLogin(false);
        setLoadError(null);
      }
    } catch {
      setLoadError('Could not reach the server.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = async () => {
    try {
      await post('/api/settings/logout');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not log out.');
      return;
    }
    await load();
  };

  return (
    <main className="page">
      <h1>Settings</h1>
      {notice && (
        <p className="error" role="alert">
          {notice}
        </p>
      )}
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {needsLogin && <LoginForm onLoggedIn={() => { setNotice(null); void load(); }} />}
      {info && !info.atlassianConfigured && (
        <section className="card stack" aria-label="Atlassian connection">
          <h2>Atlassian</h2>
          <p>
            Confluence export is disabled. Set <code>ATLASSIAN_CLIENT_ID</code> and <code>ATLASSIAN_CLIENT_SECRET</code> on the
            server and restart it.
          </p>
          <p>
            See the “Confluence export” section of the README.
          </p>
        </section>
      )}
      {info?.atlassianConfigured && !info.connected && (
        <section className="card stack" aria-label="Atlassian connection">
          <h2>Atlassian</h2>
          <p>Connect an Atlassian account so boards can be exported to Confluence.</p>
          <div>
            <ConnectLink label="Connect with Atlassian" />
          </div>
        </section>
      )}
      {info?.atlassianConfigured && info.connected && <Connected info={info} reload={load} onSuccess={() => setNotice(null)} />}
      {info && (
        <div className="card">
          <button type="button" className="btn btn-secondary" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      )}
    </main>
  );
}
