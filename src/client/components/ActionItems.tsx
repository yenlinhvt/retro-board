import { useId, useRef, useState, type FormEvent } from 'react';
import { LIMITS } from '../../shared/constants';
import type { ActionItemView, NoteView, ParticipantView } from '../../shared/types';
import type { Emit } from '../lib/useBoard';

const NOTE_OPTION_CHARS = 60;

const truncate = (s: string) => (s.length > NOTE_OPTION_CHARS ? `${s.slice(0, NOTE_OPTION_CHARS)}…` : s);

function ItemRow({ item, noteText, readOnly, emit }: { item: ActionItemView; noteText?: string; readOnly: boolean; emit: Emit }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [owner, setOwner] = useState(item.owner);
  const inFlight = useRef(false);
  const canEdit = item.canEdit && !readOnly;

  const save = async () => {
    const t = text.trim();
    if (!t || inFlight.current) return;
    inFlight.current = true;
    try {
      const ack = await emit('action:edit', { id: item.id, text: t, owner: owner.trim() });
      if (ack.ok) setEditing(false);
    } finally {
      inFlight.current = false;
    }
  };

  if (editing) {
    return (
      <li className="action-item">
        <div className="inline-form">
          <input aria-label="Edit action text" value={text} maxLength={LIMITS.actionText} onChange={(e) => setText(e.target.value)} />
          <input aria-label="Edit action owner" value={owner} maxLength={LIMITS.actionOwner} onChange={(e) => setOwner(e.target.value)} />
          <button type="button" className="btn btn-primary btn-small" disabled={!text.trim()} onClick={save}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              setText(item.text);
              setOwner(item.owner);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="action-item">
      <span className="action-text">{item.text}</span>
      {item.owner && <span className="muted"> — {item.owner}</span>}
      {noteText !== undefined && <span className="muted"> (from note: {truncate(noteText)})</span>}
      {canEdit && (
        <span className="note-actions">
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              setText(item.text);
              setOwner(item.owner);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              if (window.confirm('Delete this action item?')) void emit('action:delete', { id: item.id });
            }}
          >
            Delete
          </button>
        </span>
      )}
    </li>
  );
}

export type ActionItemsProps = {
  items: ActionItemView[];
  notes: NoteView[];
  participants: ParticipantView[];
  readOnly: boolean;
  emit: Emit;
};

export function ActionItems({ items, notes, participants, readOnly, emit }: ActionItemsProps) {
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('');
  const [noteId, setNoteId] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const listId = useId();
  const publicNotes = notes.filter((n) => n.isPublic);
  const noteById = new Map(notes.map((n) => [n.id, n.text]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const ack = await emit('action:add', { text: t, owner: owner.trim(), noteId: noteId || null });
      if (ack.ok) {
        setText('');
        setOwner('');
        setNoteId('');
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section className="card stack" aria-label="Action items">
      <h2>Action items</h2>
      {items.length === 0 && <p className="muted">No action items yet.</p>}
      <ul className="note-list">
        {items.map((it) => (
          <ItemRow key={it.id} item={it} noteText={it.noteId ? noteById.get(it.noteId) : undefined} readOnly={readOnly} emit={emit} />
        ))}
      </ul>
      {!readOnly && (
        <form className="inline-form" onSubmit={submit}>
          <input
            aria-label="Action item"
            placeholder="What needs to happen?"
            value={text}
            maxLength={LIMITS.actionText}
            onChange={(e) => setText(e.target.value)}
          />
          <input
            aria-label="Owner"
            placeholder="Owner"
            list={listId}
            value={owner}
            maxLength={LIMITS.actionOwner}
            onChange={(e) => setOwner(e.target.value)}
          />
          <datalist id={listId}>
            {participants.map((p) => (
              <option key={p.publicId} value={p.name} />
            ))}
          </datalist>
          <select aria-label="From note" value={noteId} onChange={(e) => setNoteId(e.target.value)}>
            <option value="">From note (optional)</option>
            {publicNotes.map((n) => (
              <option key={n.id} value={n.id}>
                {truncate(n.text)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || pending}>
            Add action item
          </button>
        </form>
      )}
    </section>
  );
}
