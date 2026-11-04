import { useRef, useState } from 'react';
import { LIMITS } from '../../shared/constants';
import type { Ack, NoteView } from '../../shared/types';
import { NoteCard, type NoteActions } from './NoteCard';
import { EmojiPicker } from './EmojiPicker';
import { authorColor } from '../lib/authorColor';

/** Oldest first, so new notes land at the end and nothing jumps while people read. A public note dates from its share. */
export function orderNotes(notes: NoteView[]): NoteView[] {
  const at = (n: NoteView) => n.sharedAt ?? n.createdAt;
  return [...notes].sort((a, b) => at(a).localeCompare(at(b)));
}

export type ColumnProps = {
  index: number;
  name: string;
  notes: NoteView[];
  votesRemaining: number;
  onAdd: (columnIndex: number, text: string) => Promise<Ack>;
  onEdit: NoteActions['onEdit'];
  onDelete: NoteActions['onDelete'];
  onShare: NoteActions['onShare'];
  onVote: NoteActions['onVote'];
  onUnvote: NoteActions['onUnvote'];
  /** Ids oldest first, so they keep their order once shared. */
  onShareAll: (noteIds: string[]) => void;
  readOnly: boolean;
  isAdmin: boolean;
  colorOf?: (authorPublicId: string) => string;
  /** Present mode: only shared notes with vote counts, no controls. */
  presenting?: boolean;
};

export function Column(props: ColumnProps) {
  const { index, name, notes, votesRemaining, onAdd, readOnly, isAdmin, colorOf = authorColor, presenting = false } = props;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const actions: NoteActions = {
    onEdit: props.onEdit,
    onDelete: props.onDelete,
    onShare: props.onShare,
    onVote: props.onVote,
    onUnvote: props.onUnvote,
  };
  const mine = orderNotes(notes.filter((n) => !n.isPublic && n.isMine));
  const shared = orderNotes(notes.filter((n) => n.isPublic));
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
      </header>

      <div className="column-area" role="group" aria-label="Shared">
        <h3>Shared</h3>
        <ul className="note-list">
          {shared.map((n) => (
            <NoteCard key={n.id} note={n} votesRemaining={votesRemaining} readOnly={readOnly} isAdmin={isAdmin} actions={actions} color={colorOf(n.authorPublicId)} presenting={presenting} />
          ))}
        </ul>
      </div>

      {!presenting && (!readOnly || mine.length > 0) && (
        <div className="column-area column-area--private" role="group" aria-label="Your private notes">
          <div className="column-area-header">
            <h3>Your private notes</h3>
            {!readOnly && mine.length > 0 && (
              <button
                className="btn btn-secondary btn-small"
                type="button"
                onClick={() => props.onShareAll(mine.map((n) => n.id))}
              >
                Share all ({mine.length})
              </button>
            )}
          </div>
          <ul className="note-list">
            {mine.map((n) => (
              <NoteCard key={n.id} note={n} votesRemaining={votesRemaining} readOnly={readOnly} isAdmin={isAdmin} actions={actions} color={colorOf(n.authorPublicId)} presenting={presenting} />
            ))}
          </ul>
          {!readOnly && (<>
          <textarea
            ref={box}
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
            <EmojiPicker target={box} value={draft} onChange={setDraft} max={LIMITS.noteText} />
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
    </section>
  );
}
