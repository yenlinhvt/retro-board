import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIMITS } from '../../shared/constants';

type Created = { boardId: string; adminToken: string; participantUrl: string; adminUrl: string };

function CopyRow({ label, hint, url, tone }: { label: string; hint?: string; url: string; tone?: 'danger' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable: the link is selectable text */
    }
  };
  return (
    <div className="link-row">
      <div className={tone === 'danger' ? 'link-label link-label--danger' : 'link-label'}>{label}</div>
      {hint && <p className="muted">{hint}</p>}
      <div className="link-line">
        <code className="link-url">{url}</code>
        <button type="button" className="btn btn-secondary" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const [name, setBoardName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), inviteCode }),
      });
      if (res.status === 201) {
        setCreated((await res.json()) as Created);
      } else if (res.status === 403) {
        setError("That invite code isn't valid.");
      } else if (res.status === 429) {
        setError('Too many attempts — try again in a minute.');
      } else if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? 'Please check your input and try again.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <main className="page">
        <h1>Board created</h1>
        <div className="card stack">
          <CopyRow label="Share with your team" url={created.participantUrl} />
          <CopyRow
            label="Your admin link — keep it secret"
            hint="Anyone with this link can control the board: close it, delete it, and change settings."
            url={created.adminUrl}
            tone="danger"
          />
          <div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate(`/b/${created.boardId}?admin=${encodeURIComponent(created.adminToken)}`)}
            >
              Open as admin
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Retro Board</h1>
      <p className="muted">Run a retrospective with your team in real time.</p>
      <form className="card stack" onSubmit={submit}>
        <label className="field">
          <span>Board name</span>
          <input
            value={name}
            onChange={(e) => setBoardName(e.target.value)}
            maxLength={LIMITS.boardName}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>Invite code</span>
          <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required autoComplete="off" />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create board'}
          </button>
        </div>
      </form>
    </main>
  );
}
