import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const EventsContext = createContext(null);

/** One shared EventSource for the whole app; components subscribe to it. */
export function EventsProvider({ children }) {
  const listeners = useRef(new Set());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      for (const fn of listeners.current) fn(event);
    };
    return () => source.close();
  }, []);

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  return <EventsContext.Provider value={{ connected, subscribe }}>{children}</EventsContext.Provider>;
}

export const useEventsStatus = () => useContext(EventsContext).connected;

/** Call `handler(event)` for every server event. The latest handler is always used. */
export function useEvents(handler) {
  const { subscribe } = useContext(EventsContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}

/** Re-run `reload` (debounced) whenever an event of one of `types` arrives. */
export function useLiveReload(reload, types, delay = 500) {
  const timer = useRef(null);
  const typesKey = types.join(',');
  useEvents((event) => {
    if (!typesKey.split(',').includes(event.type)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => reload(true), delay);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
}
