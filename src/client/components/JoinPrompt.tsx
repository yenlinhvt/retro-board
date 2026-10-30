import { useState, type FormEvent } from 'react';
import { LIMITS } from '../../shared/constants';

export function JoinPrompt({ onJoin }: { onJoin: (name: string) => void }) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed) onJoin(trimmed);
  };
  return (
    <main className="page">
      <form className="card stack" onSubmit={submit}>
        <h1>Join the retro</h1>
        <label className="field">
          <span>Your name</span>
          <input value={name} maxLength={LIMITS.displayName} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!trimmed}>
          Join
        </button>
      </form>
    </main>
  );
}
