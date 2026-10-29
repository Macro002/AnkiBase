/** The apps. The iPhone app (ios/) injects `window.ankibaseNative` before the page loads and
 *  answers messages posted to `webkit.messageHandlers.ankibase`; the Android app (android/)
 *  offers the same through its `AnkiBaseAndroid` object. The computer apps (desktop/) only
 *  inject `window.ankibaseNative`. */
import { useEffect, useState } from 'react';

interface NativeInfo { version: string; build: string; platform: string }
interface NativeWindow {
  ankibaseNative?: NativeInfo;
  webkit?: { messageHandlers?: { ankibase?: { postMessage: (message: unknown) => void } } };
  AnkiBaseAndroid?: { info: () => string; postMessage: (json: string) => void };
}

const w = (typeof window !== 'undefined' ? window : {}) as NativeWindow;

function androidInfo(): NativeInfo | null {
  try { return w.AnkiBaseAndroid ? JSON.parse(w.AnkiBaseAndroid.info()) : null; } catch { return null; }
}

export const native: NativeInfo | null = w.ankibaseNative ?? androidInfo();
export const isNative = native !== null;
export const isAndroid = native?.platform === 'android';
export const isDesktop = ['windows', 'macos', 'linux'].includes(native?.platform ?? '');
/** What the app runs on, for "this phone" / "this computer". */
export const device = isDesktop ? 'computer' : 'phone';

function post(message: Record<string, unknown>) {
  try {
    if (w.AnkiBaseAndroid) w.AnkiBaseAndroid.postMessage(JSON.stringify(message));
    else w.webkit?.messageHandlers?.ankibase?.postMessage(message);
  } catch { /* not in the app */ }
}

/** App icons built into the app (scripts/build.sh), one per built-in theme. */
const ICONS: { name: string; accent: string; bg: string }[] = [
  { name: 'AnkiBase', accent: '#e94560', bg: '#16213e' },
  { name: 'Midnight', accent: '#a855f7', bg: '#141414' },
  { name: 'Chalk', accent: '#06b6d4', bg: '#ffffff' },
  { name: 'Nord', accent: '#88c0d0', bg: '#3b4252' },
  { name: 'Starlake', accent: '#cba6f7', bg: '#181825' },
  { name: 'Sakura', accent: '#f4a7c3', bg: '#f8eef2' },
  { name: 'Ocean', accent: '#0ea5e9', bg: '#051828' },
  { name: 'Claude', accent: '#c4704f', bg: '#292524' },
  { name: 'Phantom', accent: '#10b981', bg: '#0f0f22' },
];

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [n >> 16, (n >> 8) & 0xff, n & 0xff];
}

function distance(a: string, b: string) {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export function luminance(hex: string) {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** The built-in icon closest to these colours (custom colours get the nearest one). */
export function iconFor(accent: string, bg: string): string {
  let best = ICONS[0];
  let bestScore = Infinity;
  for (const icon of ICONS) {
    const score = distance(icon.accent, accent) * 2 + distance(icon.bg, bg);
    if (score < bestScore) { best = icon; bestScore = score; }
  }
  return best.name;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let lastTheme = '';
let themeTimer: ReturnType<typeof setTimeout> | undefined;

/** Tell the app the current colours: the status bar, the area behind the page and the
 *  home screen icon follow the theme. Debounced, so dragging a colour picker is cheap. */
export function syncNativeTheme() {
  if (!isNative) return;
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => {
    const accent = cssVar('--accent') || '#e94560';
    const bar = cssVar('--bg-secondary') || '#16213e';
    const page = cssVar('--bg-primary') || '#1a1a2e';
    const message = { type: 'theme', accent, bar, page, dark: luminance(bar) < 0.5, icon: iconFor(accent, bar) };
    const key = JSON.stringify(message);
    if (key === lastTheme) return;
    lastTheme = key;
    post(message);
  }, 250);
}

/** A light tap, for answering cards and toggles. */
export function haptic(style: 'light' | 'medium' | 'success' | 'warning' = 'light') {
  if (isNative) post({ type: 'haptic', style });
}

// --- The app's own status: server, connection, changes waiting to be sent ------------

export interface AppStatus {
  native: boolean;
  version: string;
  build: string;
  server: string | null;
  default_server: string | null;
  server_login: boolean;
  online: boolean;
  pending: number;
  collection_error: string | null;
}

let status: AppStatus | null = null;
const listeners = new Set<(s: AppStatus) => void>();

async function fetchStatus(check: boolean): Promise<AppStatus | null> {
  try {
    const r = await fetch(check ? '/api/app/check' : '/api/app', { method: check ? 'POST' : 'GET' });
    if (!r.ok) return status;
    status = await r.json();
    listeners.forEach(l => l(status!));
  } catch { /* the app answers this itself; nothing to do */ }
  return status;
}

export const appStatus = {
  get: () => status,
  refresh: () => fetchStatus(false),
  /** Try the server again now (and send what's waiting). */
  check: () => fetchStatus(true),
  setServer: async (url: string | null) => {
    const r = await fetch('/api/app/server', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || 'Could not change the server');
    status = body;
    listeners.forEach(l => l(status!));
    return status!;
  },
};

/** The app's status, kept fresh: checked on start, when the app comes back to the
 *  foreground, and every 30 s while the server is unreachable or changes are waiting. */
export function useAppStatus(): AppStatus | null {
  const [value, setValue] = useState<AppStatus | null>(status);
  useEffect(() => {
    if (!isNative) return;
    listeners.add(setValue);
    if (!status) fetchStatus(false);
    const onVisible = () => { if (document.visibilityState === 'visible') fetchStatus(true); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    const timer = setInterval(() => {
      if (status && status.server && (!status.online || status.pending > 0)) fetchStatus(true);
    }, 30000);
    return () => {
      listeners.delete(setValue);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      clearInterval(timer);
    };
  }, []);
  return value;
}

/** Whether server-only features (stories, AI, Quizlet, dictionary) are available. */
export function hasServer(s: AppStatus | null = status): boolean {
  return !isNative || !!s?.server;
}
