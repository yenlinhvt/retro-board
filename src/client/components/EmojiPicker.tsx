import { useEffect, useRef, useState, type RefObject } from 'react';

export const EMOJIS = [
  '👍', '👎', '🎉', '🔥', '❤️', '😀', '😂', '😅', '😍', '🤔',
  '😬', '😢', '😡', '🙏', '👏', '💪', '🚀', '🐛', '⏰', '💡',
  '✅', '❌', '⚠️', '📈', '📉', '🤝', '🧠', '☕', '🍕', '⭐',
] as const;

/** Replaces the selection [start, end) with `insert`, dropping it if the result would exceed `max`. */
export function insertAt(text: string, insert: string, start: number, end: number, max: number): { text: string; cursor: number } {
  const next = text.slice(0, start) + insert + text.slice(end);
  if (next.length > max) return { text, cursor: end };
  return { text: next, cursor: start + insert.length };
}

/** 😀 button that inserts an emoji at the cursor of `target`. */
export function EmojiPicker({
  target,
  value,
  onChange,
  max,
}: {
  target: RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (text: string) => void;
  max: number;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const pick = (emoji: string) => {
    const el = target.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const r = insertAt(value, emoji, start, end, max);
    onChange(r.text);
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.cursor, r.cursor);
    });
  };

  return (
    <div className="emoji-picker" ref={root}>
      <button
        type="button"
        className="btn btn-secondary btn-small"
        aria-label="Add emoji"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        😀
      </button>
      {open && (
        <div className="emoji-grid" role="group" aria-label="Emoji">
          {EMOJIS.map((e) => (
            <button key={e} type="button" className="emoji-option" aria-label={e} onClick={() => pick(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
