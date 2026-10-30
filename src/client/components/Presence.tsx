import { useState, type FormEvent } from 'react';
import { LIMITS } from '../../shared/constants';
import type { ParticipantView } from '../../shared/types';

export function Presence({
  participants,
  onRename,
}: {
  participants: ParticipantView[];
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const me = participants.find((p) => p.isMe);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = draft.trim();
    if (!n) return;
    onRename(n);
    setEditing(false);
  };
  return (
    <section className="presence" aria-label="Participants">
      <h2>Participants</h2>
      <ul>
        {participants.map((p) => (
          <li key={p.publicId} className={p.online ? 'presence-online' : 'presence-offline'}>
            <span
              className={`presence-dot${p.online ? ' presence-dot--on' : ''}`}
              role="img"
              aria-label={p.online ? 'online' : 'offline'}
            />
            {p.name}
            {p.isMe && <span className="muted"> (you)</span>}
          </li>
        ))}
      </ul>
      {editing ? (
        <form className="inline-form" onSubmit={submit}>
          <input
            aria-label="New name"
            value={draft}
            maxLength={LIMITS.displayName}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
            Save name
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => {
            setDraft(me?.name ?? '');
            setEditing(true);
          }}
        >
          Change name
        </button>
      )}
    </section>
  );
}
