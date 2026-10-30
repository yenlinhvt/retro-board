import { useRef, useState } from 'react';
import { LIMITS } from '../../shared/constants';
import type { Ack, NoteView } from '../../shared/types';
import { NoteCard, type NoteActions } from './NoteCard';

export type SortMode = 'newest' | 'votes';

export function sortNotes(notes: NoteView[], sort: SortMode): NoteView[] {
  const copy = [...notes];
  if (sort === 'votes') {
    return copy.sort((a, b) => b.votes - a.votes || a.createdAt.localeCompare(b.createdAt));
  }
  return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type ColumnProps = {
  index: number;
  name: string;
  notes: NoteView[];
  sort: SortMode;
  votesRemaining: number;
  onSortChange: (s: SortMode) => void;
  onAdd: (columnIndex: number, text: string) => Promise<Ack>;
  onEdit: NoteActions['onEdit'];
  onDelete: NoteActions['onDelete'];
  onShare: NoteActions['onShare'];
  onVote: NoteActions['onVote'];
  onUnvote: NoteActions['onUnvote'];
  readOnly: boolean;
  isAdmin: boolean;
};

export function Column(props: ColumnProps) {
  const { index, name, notes, sort, votesRemaining, onSortChange, onAdd, readOnly, isAdmin } = props;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const actions: NoteActions = {
    onEdit: props.onEdit,
    onDelete: props.onDelete,
    onShare: props.onShare,
    onVote: props.onVote,
    onUnvote: props.onUnvote,
  };
  const mine = sortNotes(
    notes.filter((n) => !n.isPublic && n.isMine),
    'newest',
  );
  const shared = sortNotes(
    notes.filter((n) => n.isPublic),
    sort,
  );
  const trimmed = draft.trim();

  const submit = async () => {
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const ack = await onAdd(index, trimmed);
      if (ack.ok) setDraft('');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section className="column" style={{ ['--accent-col' as string]: `var(--col-${index})` }} aria-label={name}>
      <header className="column-header">
        <h2>{name}</h2>
        <div className="sort-toggle" role="group" aria-label="Sort shared notes">
          {(['newest', 'votes'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`btn btn-secondary btn-small${sort === s ? ' is-active' : ''}`}
              aria-pressed={sort === s}
              onClick={() => onSortChange(s)}
            >
              {s === 'newest' ? 'Newest' : 'Votes'}
            </button>
          ))}
        </div>
      </header>

      {(!readOnly || mine.length > 0) && (
        <div className="column-area" role="group" aria-label="Only you">
          <h3>Only you</h3>
          <ul className="note-list">
            {mine.map((n) => (
              <NoteCard key={n.id} note={n} votesRemaining={votesRemaining} readOnly={readOnly} isAdmin={isAdmin} actions={actions} />
            ))}
          </ul>
          {!readOnly && (<>
          <textarea
            aria-label={`Add a note to ${name}`}
            placeholder="Write a note (only you see it until you share)"
            value={draft}
            maxLength={LIMITS.noteText}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="note-actions">
            <span className={`muted${draft.length >= LIMITS.noteText ? ' error' : ''}`}>
              {draft.length}/{LIMITS.noteText}
            </span>
            <button className="btn btn-primary" type="button" disabled={!trimmed || pending} onClick={submit}>
              Add
            </button>
          </div>
          </>)}
        </div>
      )}

      <div className="column-area" role="group" aria-label="Shared">
        <h3>Shared</h3>
        <ul className="note-list">
          {shared.map((n) => (
            <NoteCard key={n.id} note={n} votesRemaining={votesRemaining} readOnly={readOnly} isAdmin={isAdmin} actions={actions} />
          ))}
        </ul>
      </div>
    </section>
  );
}
