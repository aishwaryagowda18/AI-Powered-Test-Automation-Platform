import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** GET `url` on mount / when it changes. `reload(true)` refreshes without a loading flash. */
export function useFetch(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(url));
  const latest = useRef(url);
  latest.current = url;

  const reload = useCallback(
    async (silent = false) => {
      if (!url) return;
      if (!silent) setLoading(true);
      try {
        const result = await api.get(url);
        if (latest.current === url) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (latest.current === url) setError(err);
      } finally {
        if (latest.current === url) setLoading(false);
      }
    },
    [url],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/** Persist a small UI preference in localStorage (fails soft in private mode). */
export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue];
}

/** Re-render every `ms` so relative timestamps ("12s ago") stay fresh. */
export function useTick(ms = 15000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}
