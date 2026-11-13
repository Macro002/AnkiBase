/** The apps. The iPhone app (ios/) injects `window.ankibaseNative` before the page loads and
 *  answers messages posted to `webkit.messageHandlers.ankibase`; the Android app (android/)
 *  offers the same through its `AnkiBaseAndroid` object. The computer apps (desktop/) only
 *  inject `window.ankibaseNative`. */
import { useEffect, useState } from 'react';

interface NativeInfo { version: string; build: string; platform: string; reminders?: ReminderSettings; tabBar?: boolean }
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
export const isIOS = native?.platform === 'ios';
/** The iPhone app draws the tab bar itself (setNativeTabs). */
export const hasNativeTabs = isIOS && !!native?.tabBar;
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

// --- Reminders (iPhone): a daily notification and the icon's badge ------------------

export interface ReminderSettings { enabled: boolean; hour: number; minute: number; denied?: boolean }

/** Only the iPhone app has reminders so far. */
export const canRemind = native?.platform === 'ios' && !!native.reminders;
let reminders: ReminderSettings | null = native?.reminders ?? null;

export function reminderSettings(): ReminderSettings | null { return reminders; }

/** Turn reminders on or off, or change their time. Turning them on asks iOS for permission:
 *  `denied` says it wasn't given (and they stay off). `strings` is the notification's text
 *  in the UI's language: title, one, other ({decks}), and, more ({count}). */
export function setReminders(next: Omit<ReminderSettings, 'denied'>, strings: Record<string, string>): Promise<ReminderSettings> {
  return new Promise(resolve => {
    const onReply = (event: Event) => {
      window.removeEventListener('ankibase-reminders', onReply);
      reminders = (event as CustomEvent<ReminderSettings>).detail;
      resolve(reminders);
    };
    window.addEventListener('ankibase-reminders', onReply);
    post({ type: 'reminders', ...next, strings });
  });
}

// What's behind changes with a sync (reviews done on other devices): count again.
if (canRemind && typeof window !== 'undefined') {
  window.addEventListener('anki-sync-complete', () => post({ type: 'reminders-refresh' }));
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

// --- The iPhone app's tab bar (a UITabBar over the page) ----------------------------

export interface NativeTab { to: string; label: string; symbol: string; badge: string | null }
let lastTabs = '';

/** The tabs, the open one (null: none of them), and whether the bar should hide. */
export function setNativeTabs(state: { items: NativeTab[]; selected: string | null; hidden: boolean }) {
  if (!hasNativeTabs) return;
  const message = { type: 'tabs', ...state };
  const key = JSON.stringify(message);
  if (key === lastTabs) return;
  lastTabs = key;
  post(message);
}

/** A tap on one of the app's tabs. Returns the unsubscribe. */
export function onNativeTab(handler: (to: string) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<{ to: string }>).detail.to);
  window.addEventListener('ankibase-tab', listener);
  return () => window.removeEventListener('ankibase-tab', listener);
}

/** Whether a full-screen overlay (`.fixed.inset-0`) covers where the tab bar is (z-40 and
 *  up), as dialogs and sheets do: the app's tab bar is drawn over the page, so it hides. */
export function useOverlayOpen(enabled: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setOpen(Array.from(document.querySelectorAll('.fixed.inset-0'))
        .some(el => (parseInt(getComputedStyle(el).zIndex, 10) || 0) >= 40));
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [enabled]);
  return open;
}

// --- Opening pages from the app (a tapped notification) -----------------------------

/** The page is up: the iPhone app may now open what a tapped notification asked for. */
export function nativeReady() {
  if (isIOS) post({ type: 'ready' });
}

/** The app asks to open a page (a story from its notification). Returns the unsubscribe. */
export function onNativeOpen(handler: (path: string) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<{ path: string }>).detail.path);
  window.addEventListener('ankibase-open', listener);
  return () => window.removeEventListener('ankibase-open', listener);
}

/** The daily story was turned on: the iPhone app asks to notify when one's ready. */
export function requestStoryAlerts() {
  if (isIOS) post({ type: 'story-alerts' });
}
