import { useState } from 'react';
import { LIMITS } from '../../shared/constants';
import type { BoardSnapshot } from '../../shared/types';
import type { Emit } from '../lib/useBoard';

/** Text/number input that commits on blur or Enter, only when the value changed and is valid. */
function CommitInput({
  label,
  value,
  type = 'text',
  validate,
  onCommit,
  ...rest
}: {
  label: string;
  value: string;
  type?: 'text' | 'number';
  validate: (v: string) => boolean;
  onCommit: (v: string) => void;
  maxLength?: number;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const v = draft.trim();
    if (v === value || !validate(v)) {
      if (v !== value) setDraft(value);
      return;
    }
    onCommit(v);
  };
  return (
    <input
      {...rest}
      aria-label={label}
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

export type AdminPanelProps = { state: BoardSnapshot; emit: Emit };

export function AdminPanel({ state, emit }: AdminPanelProps) {
  const [confirmName, setConfirmName] = useState('');
  const [copied, setCopied] = useState(false);
  const closed = state.status === 'closed';
  const link = `${window.location.origin}/b/${state.id}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* user can select the field manually */
    }
  };

  return (
    <section className="card stack" aria-label="Admin">
      <h2>Admin</h2>

      <div className="field">
        <span>Participant link</span>
        <div className="link-line">
          <input readOnly aria-label="Participant link" value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn btn-secondary btn-small" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>

      <fieldset className="stack">
        <legend>Column names</legend>
        {state.columns.map((name, i) => (
          <CommitInput
            key={`${i}:${name}`}
            label={`Column ${i + 1} name`}
            value={name}
            maxLength={LIMITS.columnName}
            validate={(v) => v.length >= 1 && v.length <= LIMITS.columnName}
            onCommit={(v) => void emit('admin:renameColumn', { columnIndex: i, name: v })}
          />
        ))}
      </fieldset>

      <label className="field">
        <span>Votes per person</span>
        <CommitInput
          key={state.voteLimit}
          label="Vote limit"
          type="number"
          min={LIMITS.voteLimitMin}
          max={LIMITS.voteLimitMax}
          value={String(state.voteLimit)}
          validate={(v) => {
            const n = Number(v);
            return v !== '' && Number.isInteger(n) && n >= LIMITS.voteLimitMin && n <= LIMITS.voteLimitMax;
          }}
          onCommit={(v) => void emit('admin:setVoteLimit', { limit: Number(v) })}
        />
      </label>

      <div>
        {closed ? (
          <button type="button" className="btn btn-secondary" onClick={() => void emit('admin:reopen', {})}>
            Reopen session
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              if (window.confirm('Close this session? The board becomes read-only.')) void emit('admin:close', {});
            }}
          >
            Close session
          </button>
        )}
      </div>

      <div className="field">
        <span>Delete board — type “{state.name}” to confirm</span>
        <div className="inline-form">
          <input aria-label="Confirm board name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          <button
            type="button"
            className="btn btn-danger"
            disabled={confirmName !== state.name}
            onClick={() => void emit('admin:delete', {})}
          >
            Delete board
          </button>
        </div>
      </div>
    </section>
  );
}
