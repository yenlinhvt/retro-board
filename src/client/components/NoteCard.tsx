import { useRef, useState } from 'react';
import { LIMITS } from '../../shared/constants';
import type { Ack, NoteView } from '../../shared/types';
import { EmojiPicker } from './EmojiPicker';

export type NoteActions = {
  onEdit: (noteId: string, text: string) => Promise<Ack>;
  onDelete: (noteId: string) => void;
  onShare: (noteId: string) => void;
  onVote: (noteId: string) => void;
  onUnvote: (noteId: string) => void;
};

export function NoteCard({
  note,
  votesRemaining,
  readOnly,
  isAdmin,
  actions,
  color,
  presenting = false,
}: {
  note: NoteView;
  votesRemaining: number;
  readOnly: boolean;
  isAdmin: boolean;
  actions: NoteActions;
  color?: string;
  presenting?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const canEdit = note.isMine && !readOnly;
  const canDelete = !readOnly && (note.isMine || (isAdmin && note.isPublic));

  const confirmDelete = () => {
    if (window.confirm('Delete this note?')) actions.onDelete(note.id);
  };
  const save = async () => {
    const t = draft.trim();
    if (!t || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const ack = await actions.onEdit(note.id, t);
      if (ack.ok) setEditing(false);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  if (presenting) {
    return (
      <li className="note" style={color ? { ['--note-color' as string]: color } : undefined}>
        <p className="note-text">{note.text}</p>
        <div className="note-footer">
          <p className="note-author muted">{note.authorName}</p>
          <span className="note-thumbs" aria-label={`${note.votes} votes`}>
            👍 {note.votes}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className="note" style={color ? { ['--note-color' as string]: color } : undefined}>
      {editing ? (
        <div className="stack">
          <textarea
            ref={box}
            aria-label="Edit note"
            value={draft}
            maxLength={LIMITS.noteText}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
          />
          <div className="note-actions">
            <EmojiPicker target={box} value={draft} onChange={setDraft} max={LIMITS.noteText} />
            <button className="btn btn-primary" type="button" onClick={save} disabled={!draft.trim() || saving}>
              Save
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setDraft(note.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="note-text">{note.text}</p>
          {note.isPublic && <p className="note-author muted">{note.authorName}</p>}
          <div className="note-actions">
            {note.isPublic && (
              <span className="note-votes">
                <button
                  className="btn btn-secondary btn-small"
                  type="button"
                  aria-label="Remove vote"
                  disabled={readOnly || note.myVotes === 0}
                  onClick={() => actions.onUnvote(note.id)}
                >
                  −
                </button>
                <span aria-label={`${note.votes} votes`}>{note.votes}</span>
                <button
                  className="btn btn-secondary btn-small"
                  type="button"
                  aria-label="Add vote"
                  disabled={readOnly || votesRemaining <= 0}
                  onClick={() => actions.onVote(note.id)}
                >
                  +
                </button>
              </span>
            )}
            {!note.isPublic && note.isMine && !readOnly && (
              <button className="btn btn-secondary btn-small" type="button" onClick={() => actions.onShare(note.id)}>
                Share
              </button>
            )}
            {canEdit && (
              <button
                className="btn btn-secondary btn-small"
                type="button"
                onClick={() => {
                  setDraft(note.text);
                  setEditing(true);
                }}
              >
                Edit
              </button>
            )}
            {canDelete && (
              <button className="btn btn-secondary btn-small" type="button" onClick={confirmDelete}>
                Delete
              </button>
            )}
          </div>
        </>
      )}
    </li>
  );
}
