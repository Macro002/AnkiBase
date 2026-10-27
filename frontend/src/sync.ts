/** Syncing the Anki collection: one sync at a time, shared by the header's Sync button,
 *  Settings → Sync and (in the app) automatic syncs when the app opens and closes. */
import { useEffect, useState } from 'react';
import { ankiweb, sync } from './api';
import { isNative } from './native';

export type SyncState = 'idle' | 'syncing';
export type SyncResult =
  | { kind: 'done'; outcome?: string }
  | { kind: 'conflict'; recommendation: 'choose' | 'download' | 'upload' }
  | { kind: 'not-configured' }
  | { kind: 'error'; message: string };

let state: SyncState = 'idle';
let running: Promise<SyncResult> | null = null;
const listeners = new Set<(s: SyncState) => void>();

function setState(next: SyncState) {
  state = next;
  listeners.forEach(l => l(next));
}

/** Sync now (joins a sync already running). `quiet` syncs report nothing unless they fail
 *  in a way the user has to act on. */
export function runSync(options: { quiet?: boolean } = {}): Promise<SyncResult> {
  if (running) return running;
  setState('syncing');
  running = (async (): Promise<SyncResult> => {
    try {
      const result = await sync.trigger();
      localStorage.setItem(LAST_AUTO, String(Date.now()));
      window.dispatchEvent(new CustomEvent('anki-sync-complete'));
      return { kind: 'done', outcome: result.outcome };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      if (message.includes('Full sync required')) {
        const rec = (message.split(':')[1] as 'choose' | 'download' | 'upload' | undefined) ?? 'choose';
        return { kind: 'conflict', recommendation: rec };
      }
      if (message.includes('not configured')) return { kind: 'not-configured' };
      return { kind: 'error', message };
    } finally {
      running = null;
      setState('idle');
    }
  })();
  const pending = running;
  pending.then(result => {
    if (options.quiet && result.kind !== 'conflict') return;
    window.dispatchEvent(new CustomEvent('anki-sync-result', { detail: result }));
  });
  return pending;
}

export function useSyncState(): SyncState {
  const [value, setValue] = useState(state);
  useEffect(() => {
    listeners.add(setValue);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

// --- Automatic syncs (the app) -----------------------------------------------------------

const AUTO_KEY = 'ankibase-auto-sync';
const LAST_AUTO = 'ankibase-last-sync';
/** Coming back to the app syncs again only after this long; leaving it, after this long. */
const OPEN_GAP_MS = 5 * 60 * 1000;
const CLOSE_GAP_MS = 60 * 1000;

export function autoSyncEnabled(): boolean {
  return isNative && localStorage.getItem(AUTO_KEY) !== 'off';
}

export function setAutoSync(on: boolean) {
  localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');
}

let configured: boolean | null = null;
export function forgetSyncLogin(value: boolean | null = null) {
  configured = value;
}

async function autoSync(gap: number) {
  if (!autoSyncEnabled() || !navigator.onLine) return;
  const last = Number(localStorage.getItem(LAST_AUTO) ?? 0);
  if (Date.now() - last < gap) return;
  if (configured === null) {
    try { configured = (await ankiweb.status()).configured; } catch { return; }
  }
  if (configured) runSync({ quiet: true });
}

/** Like Anki on phones: sync when the app opens, comes back after a while, or goes to the
 *  background (the app keeps running briefly to finish). */
export function useAutoSync() {
  useEffect(() => {
    if (!isNative) return;
    autoSync(0);
    const onVisibility = () => autoSync(document.visibilityState === 'hidden' ? CLOSE_GAP_MS : OPEN_GAP_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
}
