import { useState } from 'react';
import { LIMITS } from '../../shared/constants';
import type { Ack, NoteView } from '../../shared/types';

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
}: {
  note: NoteView;
  votesRemaining: number;
  readOnly: boolean;
  isAdmin: boolean;
  actions: NoteActions;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const canEdit = note.isMine && !readOnly;
  const canDelete = !readOnly && (note.isMine || (isAdmin && note.isPublic));

  const confirmDelete = () => {
    if (window.confirm('Delete this note?')) actions.onDelete(note.id);
  };
  const save = async () => {
    const t = draft.trim();
    if (!t) return;
    const ack = await actions.onEdit(note.id, t);
    if (ack.ok) setEditing(false);
  };

  return (
    <li className="note">
      {editing ? (
        <div className="stack">
          <textarea
            aria-label="Edit note"
            value={draft}
            maxLength={LIMITS.noteText}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
          />
          <div className="note-actions">
            <button className="btn btn-primary" type="button" onClick={save} disabled={!draft.trim()}>
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
