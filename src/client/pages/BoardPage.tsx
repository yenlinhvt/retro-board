import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useBoard } from '../lib/useBoard';
import { getIdentity, setName as storeName } from '../lib/identity';
import { JoinPrompt } from '../components/JoinPrompt';
import { Column, type SortMode } from '../components/Column';
import { Presence } from '../components/Presence';
import type { Ack } from '../../shared/types';

const SORT_KEY = 'retro.sort';
const TOAST_MS = 4000;

function readSort(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === 'votes' ? 'votes' : 'newest';
  } catch {
    return 'newest';
  }
}

function writeSort(s: SortMode): void {
  try {
    localStorage.setItem(SORT_KEY, s);
  } catch {
    /* ignore */
  }
}

const adminMemory = new Map<string, string>();

/** Reads ?admin= once, keeps it in sessionStorage, and scrubs it from the address bar. */
function resolveAdminToken(boardId: string): string | undefined {
  const key = `retro.admin.${boardId}`;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('admin');
  if (fromUrl) {
    adminMemory.set(key, fromUrl);
    try {
      sessionStorage.setItem(key, fromUrl);
    } catch {
      /* in-memory fallback */
    }
    params.delete('admin');
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(key) ?? adminMemory.get(key);
  } catch {
    return adminMemory.get(key);
  }
}

export function BoardPage() {
  const { boardId = '' } = useParams();
  const adminToken = useRef<string | undefined>();
  const resolvedFor = useRef<string | null>(null);
  if (resolvedFor.current !== boardId) {
    resolvedFor.current = boardId;
    adminToken.current = resolveAdminToken(boardId);
  }

  const [identity] = useState(getIdentity);
  const [joinName, setJoinName] = useState<string | null>(identity.name);
  const [sort, setSort] = useState<SortMode>(readSort);
  const [toast, setToast] = useState<string | null>(null);

  const auth = joinName ? { participantId: identity.participantId, name: joinName, adminToken: adminToken.current } : null;
  const { state, status, emit } = useBoard(boardId, auth);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const run = useCallback(
    async (p: Promise<Ack>) => {
      const ack = await p;
      if (!ack.ok) setToast(ack.message);
    },
    [],
  );

  if (!joinName) {
    return (
      <JoinPrompt
        onJoin={(n) => {
          storeName(n);
          setJoinName(n);
        }}
      />
    );
  }

  if (status === 'not_found' || status === 'deleted') {
    return (
      <main className="page">
        <p role="alert">This board doesn't exist or was deleted.</p>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="page">
        <p className="muted">Connecting…</p>
      </main>
    );
  }

  const closed = state.status === 'closed';
  const changeSort = (s: SortMode) => {
    setSort(s);
    writeSort(s);
  };

  return (
    <div className="board">
      {status === 'reconnecting' && (
        <div className="banner banner--warn" role="status">
          Connection lost — reconnecting…
        </div>
      )}
      {closed && (
        <div className="banner" role="status">
          This session is closed — the board is read-only.
        </div>
      )}
      <header className="board-header">
        <h1>{state.name}</h1>
        {closed && <span className="badge">Closed</span>}
        <span className="muted">
          Votes remaining: {state.votesRemaining} of {state.voteLimit}
        </span>
      </header>

      {/* Task 17 wires TimerBar here */}
      <section aria-label="Timer" data-slot="timer" />

      <div className="board-grid">
        {state.columns.map((name, i) => (
          <Column
            key={i}
            index={i}
            name={name}
            notes={state.notes.filter((n) => n.columnIndex === i)}
            sort={sort}
            votesRemaining={state.votesRemaining}
            onSortChange={changeSort}
            onAdd={(ci, text) => run(emit('note:add', { columnIndex: ci, text }))}
            onEdit={(noteId, text) => run(emit('note:edit', { noteId, text }))}
            onDelete={(noteId) => run(emit('note:delete', { noteId }))}
            onShare={(noteId) => run(emit('note:share', { noteId }))}
            onVote={(noteId) => run(emit('vote:add', { noteId }))}
            onUnvote={(noteId) => run(emit('vote:remove', { noteId }))}
            readOnly={closed}
            isAdmin={state.isAdmin}
          />
        ))}
      </div>

      <Presence
        participants={state.participants}
        onRename={(n) => {
          storeName(n);
          void run(emit('participant:rename', { name: n }));
        }}
      />

      {/* Task 17 wires ActionItems here */}
      <section aria-label="Action items" data-slot="action-items" />
      {/* Task 17 wires AdminPanel here (state.isAdmin) */}
      {state.isAdmin && <section aria-label="Admin" data-slot="admin" />}

      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}
