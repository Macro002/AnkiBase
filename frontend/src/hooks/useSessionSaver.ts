import { useCallback, useEffect, useMemo, useRef } from 'react';
import { studySessions, type SessionKind, type SessionUpdate } from '../api';

/**
 * Debounced saving of one study session (what the Study hub lists as "continue").
 *
 * - `save(update)` queues the latest snapshot; it's sent after `delay` ms of quiet.
 * - `save(update, true)` sends right away (round ends, completions).
 * - Pending saves are flushed on unmount and on `pagehide` (reloads and closed tabs
 *   don't unmount React), using `keepalive` so the request survives the unload.
 */
export function useSessionSaver(kind: SessionKind, ref: string | number | null, delay = 800) {
  const pending = useRef<SessionUpdate | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef({ kind, ref });

  const flush = useCallback((keepalive = false) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const update = pending.current;
    const { kind: k, ref: r } = target.current;
    pending.current = null;
    if (update && r != null) studySessions.put(k, r, update, keepalive).catch(() => {});
  }, []);

  // A new target (e.g. another deck) first flushes whatever belonged to the old one.
  useEffect(() => {
    flush();
    target.current = { kind, ref };
  }, [kind, ref, flush]);

  useEffect(() => {
    const onHide = () => flush(true);
    window.addEventListener('pagehide', onHide);
    return () => { window.removeEventListener('pagehide', onHide); flush(); };
  }, [flush]);

  const save = useCallback((update: SessionUpdate, immediate = false) => {
    pending.current = update;
    if (timer.current) clearTimeout(timer.current);
    if (immediate) flush();
    else timer.current = setTimeout(() => flush(), delay);
  }, [delay, flush]);

  /** Drop any queued save and delete the session. */
  const remove = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = null;
    const { kind: k, ref: r } = target.current;
    if (r != null) studySessions.remove(k, r).catch(() => {});
  }, []);

  return useMemo(() => ({ save, flush, remove }), [save, flush, remove]);
}
