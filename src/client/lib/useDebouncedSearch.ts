import { useEffect, useRef, useState } from 'react';

const DEBOUNCE_MS = 300;

/** Runs `load` after a debounce (immediately on first run); ignores stale results. */
export function useDebouncedSearch<T>(
  q: string,
  enabled: boolean,
  load: (q: string) => Promise<T[]>,
  onError: (m: string) => void,
  resetKey: string,
): T[] {
  const [results, setResults] = useState<T[]>([]);
  const first = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const errRef = useRef(onError);
  errRef.current = onError;

  useEffect(() => {
    first.current = true;
  }, [resetKey]);

  useEffect(() => {
    if (!enabled) {
      setResults([]);
      return;
    }
    let stale = false;
    const delay = first.current ? 0 : DEBOUNCE_MS;
    first.current = false;
    const t = setTimeout(() => {
      loadRef
        .current(q)
        .then((r) => {
          if (!stale) setResults(r);
        })
        .catch((e: Error) => {
          if (!stale) errRef.current(e.message);
        });
    }, delay);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, enabled, resetKey]);

  return results;
}
