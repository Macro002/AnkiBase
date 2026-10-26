import type { StatsPeriod } from '../../api';

/**
 * Fixed colors per category (dark steps of the dataviz reference palette).
 * Validated as adjacent pairs against the app's dark surfaces — a category keeps
 * its color in every chart, and stacks use the validated order below.
 */
export const C = {
  new: '#3987e5',
  learning: '#d95926',
  young: '#199e70',
  mature: '#008300',
  relearning: '#e66767',
  filtered: '#9085e9',
  quizlet: '#d55181',
  suspended: '#c98500',
  buried: '#898781',
  again: '#e66767',
  hard: '#9085e9',
  good: '#008300',
  easy: '#3987e5',
} as const;

/** Bottom → top. This order passes the colorblind/normal-vision adjacency checks. */
export const REVIEW_STACK = [
  { key: 'learn', label: 'Learning', color: C.learning },
  { key: 'young', label: 'Young', color: C.young },
  { key: 'filtered', label: 'Filtered', color: C.filtered },
  { key: 'relearn', label: 'Relearning', color: C.relearning },
  { key: 'mature', label: 'Mature', color: C.mature },
  { key: 'quizlet', label: 'Quizlet', color: C.quizlet },
] as const;

export const BUTTONS = [
  { label: 'Again', color: C.again },
  { label: 'Hard', color: C.hard },
  { label: 'Good', color: C.good },
  { label: 'Easy', color: C.easy },
] as const;

export const PERIOD_DAYS: Record<StatsPeriod, number | null> = { '1m': 30, '3m': 91, '1y': 365, all: null };
export type Bucket = 'day' | 'week' | 'month';
export const defaultBucket = (p: StatsPeriod): Bucket => (p === '1m' ? 'day' : p === '3m' ? 'week' : p === '1y' ? 'week' : 'month');

// --- dates (YYYY-MM-DD strings, treated as calendar days) ---------------------

export const parseDay = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const startOfWeek = (d: Date) => addDays(d, -((d.getUTCDay() + 6) % 7)); // Monday
const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export function bucketStart(d: Date, b: Bucket): Date {
  return b === 'day' ? d : b === 'week' ? startOfWeek(d) : startOfMonth(d);
}

export function bucketLabel(d: Date, b: Bucket, long = false): string {
  if (b === 'month') return d.toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: long || d.getUTCMonth() === 0 ? 'numeric' : undefined, timeZone: 'UTC' });
  const s = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return b === 'week' && long ? `Week of ${s}` : s;
}

/**
 * Sum per-day records into contiguous day/week/month buckets ending today.
 * `days` null = from the earliest date in the data.
 */
export function bucketize<T extends Record<string, number>>(
  daily: Record<string, T>, today: string, days: number | null, b: Bucket,
): { start: Date; label: string; long: string; values: Record<string, number> }[] {
  const end = parseDay(today);
  let first: Date;
  if (days != null) first = addDays(end, -(days - 1));
  else {
    const keys = Object.keys(daily).sort();
    first = keys.length ? parseDay(keys[0]) : end;
  }
  const out = new Map<string, { start: Date; label: string; long: string; values: Record<string, number> }>();
  for (let d = bucketStart(first, b); d <= end; d = b === 'day' ? addDays(d, 1) : b === 'week' ? addDays(d, 7) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    out.set(fmtDay(d), { start: d, label: bucketLabel(d, b), long: bucketLabel(d, b, true), values: {} });
  }
  for (const [day, rec] of Object.entries(daily)) {
    const d = parseDay(day);
    if (d < first || d > end) continue;
    const slot = out.get(fmtDay(bucketStart(d, b)));
    if (!slot) continue;
    for (const [k, v] of Object.entries(rec)) slot.values[k] = (slot.values[k] ?? 0) + v;
  }
  return [...out.values()];
}

// --- formatting -------------------------------------------------------------

export const fmtInt = (n: number) => n.toLocaleString();
export const compact = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(Math.round(n)));
export const pct = (num: number, den: number, digits = 0) => (den > 0 ? `${((num / den) * 100).toFixed(digits)}%` : '—');

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 60) return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
  const h = m / 60;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

export function fmtIvl(days: number): string {
  if (days < 31) return `${days}d`;
  const trim = (n: number) => String(Number(n.toFixed(1)));
  if (days < 365) return `${trim(days / 30)}mo`;
  return `${trim(days / 365)}y`;
}

// --- recharts styling -------------------------------------------------------

export const axisProps = {
  tick: { fill: 'var(--text-secondary)', fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: 'rgba(255,255,255,0.12)' },
} as const;

export const yAxisProps = {
  ...axisProps,
  axisLine: false,
  width: 40,
  allowDecimals: false,
  tickFormatter: (v: number) => compact(v),
} as const;

export const gridProps = { vertical: false, stroke: 'rgba(255,255,255,0.07)' } as const;
export const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];
