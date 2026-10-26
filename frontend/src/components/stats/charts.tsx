import { useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line } from 'recharts';
import type { AnkiStats, QuizletStats, StatsPeriod } from '../../api';
import {
  C, REVIEW_STACK, BUTTONS, PERIOD_DAYS, defaultBucket, bucketize, parseDay, addDays, fmtDay,
  fmtInt, pct, fmtDuration, fmtIvl, axisProps, yAxisProps, gridProps, BAR_RADIUS, type Bucket,
} from './shared';
import { ChartCard, Legend, Stat, S, TipBox, DataTable } from './ui';
import { Segmented } from '../quizlet/ui';

const cursor = { fill: 'rgba(255,255,255,0.05)' };
const H = 220;

// --- Today --------------------------------------------------------------------

export function TodaySection({ anki, quizlet }: { anki: AnkiStats | null; quizlet: QuizletStats | null }) {
  const t = anki?.today;
  const q = quizlet?.today;
  const studied = (t?.reviews ?? 0) + (q?.answers ?? 0);
  return (
    <ChartCard title="Today"
      summary={t && t.reviews > 0 ? <>
        <S k="Learning" v={fmtInt(t.learn)} /><S k="Review" v={fmtInt(t.review)} />
        <S k="Relearning" v={fmtInt(t.relearn)} /><S k="Filtered" v={fmtInt(t.filtered)} />
      </> : undefined}>
      {studied === 0 ? (
        <p className="text-sm text-(--text-secondary)">No cards studied today yet.</p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Studied" value={fmtInt(studied)} accent
            hint={t ? `${fmtInt(t.reviews)} in Anki${q ? ` · ${fmtInt(q.answers)} in Quizlet` : ''}` : `${fmtInt(q?.answers ?? 0)} Quizlet answers`} />
          {t && t.reviews > 0 && <>
            <Stat label="Time in Anki" value={fmtDuration(t.seconds)} hint={`${(t.seconds / t.reviews).toFixed(1)}s per card`} />
            <Stat label="Again" value={fmtInt(t.again)} hint={`${pct(t.reviews - t.again, t.reviews)} correct`} />
          </>}
          {t && t.mature_total > 0 && <Stat label="Mature cards correct" value={pct(t.mature_correct, t.mature_total)} hint={`${t.mature_correct} of ${t.mature_total}`} />}
          {q && q.answers > 0 && <Stat label="Quizlet correct" value={pct(q.correct, q.answers)} hint={`${q.correct} of ${q.answers} answers`} />}
        </div>
      )}
    </ChartCard>
  );
}

// --- Reviews (count / time) -------------------------------------------------------

export function ReviewsChart({ anki, quizlet, period, today }: { anki: AnkiStats | null; quizlet: QuizletStats | null; period: StatsPeriod; today: string }) {
  const [measure, setMeasure] = useState<'count' | 'time'>('count');
  const [bucket, setBucket] = useState<Bucket>(defaultBucket(period));
  const [lastPeriod, setLastPeriod] = useState(period);
  if (period !== lastPeriod) { setLastPeriod(period); setBucket(defaultBucket(period)); }

  const time = measure === 'time';
  const series = REVIEW_STACK.filter(s => (s.key === 'quizlet' ? !!quizlet && !time : !!anki));
  const data = useMemo(() => {
    const merged: Record<string, Record<string, number>> = {};
    for (const [d, rec] of Object.entries(anki?.daily ?? {})) merged[d] = { ...rec };
    for (const [d, n] of Object.entries(quizlet?.daily ?? {})) merged[d] = { ...(merged[d] ?? {}), quizlet: n };
    return bucketize(merged, today, PERIOD_DAYS[period], bucket).map(b => {
      const row: Record<string, number | string> = { label: b.label, long: b.long };
      for (const s of series) row[s.key] = time ? (b.values[`${s.key}_s`] ?? 0) / 60 : (b.values[s.key] ?? 0);
      return row;
    });
  }, [anki, quizlet, today, period, bucket, time, series]);

  // Summary over days (not buckets), like Anki.
  const dayTotals = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [d, rec] of Object.entries(anki?.daily ?? {})) {
      m[d] = series.reduce((n, s) => n + (s.key === 'quizlet' ? 0 : time ? (rec[`${s.key}_s`] ?? 0) / 60 : (rec[s.key] ?? 0)), 0);
    }
    if (!time) for (const [d, n] of Object.entries(quizlet?.daily ?? {})) m[d] = (m[d] ?? 0) + n;
    return m;
  }, [anki, quizlet, series, time]);
  const studiedDays = Object.values(dayTotals).filter(v => v > 0).length;
  const total = Object.values(dayTotals).reduce((a, b) => a + b, 0);
  const spanDays = PERIOD_DAYS[period] ?? Math.max(1, Math.round((parseDay(today).getTime() - parseDay(Object.keys(dayTotals).sort()[0] ?? today).getTime()) / 86400000) + 1);
  const fmt = (v: number) => (time ? fmtDuration(v * 60) : fmtInt(Math.round(v)));

  return (
    <ChartCard title={time ? 'Review time' : 'Reviews'}
      subtitle={time ? 'Minutes spent answering, by card type (Quizlet doesn’t record time)' : 'Answers per period, by card type'}
      actions={<>
        <Segmented value={measure} onChange={setMeasure} options={[{ value: 'count', label: 'Count' }, { value: 'time', label: 'Time' }]} />
        <span className="hidden sm:inline-flex"><Segmented value={bucket} onChange={setBucket} options={[{ value: 'day', label: 'Days' }, { value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} /></span>
      </>}
      table={{ columns: ['Period', ...series.map(s => s.label), 'Total'], rows: data.map(r => [String(r.long), ...series.map(s => fmt(Number(r[s.key]))), fmt(series.reduce((n, s) => n + Number(r[s.key]), 0))]) }}
      summary={<>
        <S k="Days studied" v={`${studiedDays} of ${spanDays} (${pct(studiedDays, spanDays)})`} />
        <S k="Total" v={time ? fmtDuration(total * 60) : `${fmtInt(Math.round(total))} reviews`} />
        <S k="Average for days studied" v={studiedDays ? fmt(total / studiedDays) : '—'} />
        <S k="Average over period" v={fmt(total / spanDays)} />
      </>}>
      <Legend items={series.map(s => ({ label: s.label, color: s.color }))} />
      <ResponsiveContainer width="100%" height={H + 20}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} minTickGap={16} />
          <YAxis {...yAxisProps} tickFormatter={v => (time ? `${Math.round(v)}m` : yAxisProps.tickFormatter(v))} />
          <Tooltip cursor={cursor} content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as Record<string, number | string>;
            const rows = [...series].reverse().filter(s => Number(row[s.key]) > 0).map(s => ({ color: s.color, label: s.label, value: fmt(Number(row[s.key])) }));
            const sum = series.reduce((n, s) => n + Number(row[s.key]), 0);
            return <TipBox title={String(row.long)} rows={rows.length ? rows : [{ label: 'no reviews', value: '0' }]} footer={rows.length > 1 ? <>Total <b className="text-white">{fmt(sum)}</b></> : undefined} />;
          }} />
          {series.map(s => (
            <Bar key={s.key} dataKey={s.key} stackId="r" fill={s.color} maxBarSize={24}
              stroke="var(--bg-secondary)" strokeWidth={data.length > 60 ? 0 : 1} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// --- Future due ---------------------------------------------------------------

export function FutureDue({ anki, period, today }: { anki: AnkiStats; period: StatsPeriod; today: string }) {
  const fd = anki.future_due;
  const days = Object.fromEntries(Object.entries(fd.days).map(([k, v]) => [Number(k), v]));
  const maxRel = Math.max(0, ...Object.keys(days).map(Number));
  const horizon = PERIOD_DAYS[period] ?? Math.min(Math.max(maxRel + 1, 30), 3650);
  const bucket: Bucket = horizon <= 91 ? 'day' : horizon <= 365 ? 'week' : 'month';
  const t0 = parseDay(today);
  const daily: Record<string, { due: number }> = {};
  for (let rel = 0; rel < horizon; rel++) {
    const n = (days[rel] ?? 0) + (rel === 0 ? fd.learning_today : 0);
    if (n) daily[fmtDay(addDays(t0, rel))] = { due: n };
  }
  // bucketize counts backwards from "today"; shift by using the horizon end as its "today".
  const end = fmtDay(addDays(t0, horizon - 1));
  const data = bucketize(daily, end, horizon, bucket).map(b => ({ label: b.label, long: b.long, due: b.values.due ?? 0 }));
  const total = Object.values(daily).reduce((n, v) => n + v.due, 0);
  const tomorrow = days[1] ?? 0;

  return (
    <ChartCard title="Future due" subtitle="Reviews coming up if you keep up with everything (new cards not included)"
      table={{ columns: ['When', 'Due'], rows: data.map(d => [d.long, fmtInt(d.due)]) }}
      summary={<>
        <S k="Total" v={fmtInt(total)} /><S k="Average" v={`${(total / horizon).toFixed(1)}/day`} />
        <S k="Due tomorrow" v={fmtInt(tomorrow)} /><S k="Daily load" v={fmtInt(fd.daily_load)} />
        {fd.overdue > 0 && <S k="Overdue" v={fmtInt(fd.overdue)} />}
      </>}>
      {!fd.known && <p className="text-xs text-(--text-secondary)">No review cards yet, so nothing is scheduled.</p>}
      <ResponsiveContainer width="100%" height={H}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} minTickGap={16} />
          <YAxis {...yAxisProps} />
          <Tooltip cursor={cursor} content={({ active, payload }) => active && payload?.length
            ? <TipBox title={String(payload[0].payload.long)} rows={[{ label: 'due', value: fmtInt(Number(payload[0].payload.due)) }]} /> : null} />
          <Bar dataKey="due" fill="var(--accent)" radius={BAR_RADIUS} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// --- Calendar -------------------------------------------------------------------

export function CalendarHeatmap({ anki, quizlet, today }: { anki: AnkiStats | null; quizlet: QuizletStats | null; today: string }) {
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [d, n] of Object.entries(anki?.calendar ?? {})) m[d] = (m[d] ?? 0) + n;
    for (const [d, n] of Object.entries(quizlet?.calendar ?? {})) m[d] = (m[d] ?? 0) + n;
    return m;
  }, [anki, quizlet]);
  const thisYear = parseDay(today).getUTCFullYear();
  const years = useMemo(() => {
    const ys = new Set([thisYear, ...Object.keys(counts).map(d => Number(d.slice(0, 4)))]);
    return [...ys].sort((a, b) => b - a);
  }, [counts, thisYear]);
  const [year, setYear] = useState(thisYear);
  const [hover, setHover] = useState<{ d: string; n: number; x: number; y: number } | null>(null);

  // Levels from quartiles of active days, so one huge day doesn't wash everything out.
  const levels = useMemo(() => {
    const vals = Object.values(counts).filter(v => v > 0).sort((a, b) => a - b);
    const q = (p: number) => vals[Math.floor((vals.length - 1) * p)] ?? 0;
    return [q(0.25), q(0.5), q(0.75)];
  }, [counts]);
  const shade = (n: number) => n <= 0 ? 'var(--bg-tertiary)'
    : `rgba(var(--accent-rgb), ${n <= levels[0] ? 0.3 : n <= levels[1] ? 0.5 : n <= levels[2] ? 0.75 : 1})`;

  const jan1 = new Date(Date.UTC(year, 0, 1));
  const start = addDays(jan1, -((jan1.getUTCDay() + 6) % 7));
  const weeks: { d: Date; inYear: boolean }[][] = [];
  for (let w = 0; w < 54; w++) {
    const col = Array.from({ length: 7 }, (_, i) => { const d = addDays(start, w * 7 + i); return { d, inYear: d.getUTCFullYear() === year }; });
    if (w > 0 && !col.some(c => c.inYear)) break;
    weeks.push(col);
  }

  // Streaks over all history.
  const { current, longest, active, busiest } = useMemo(() => {
    const days = Object.keys(counts).filter(d => counts[d] > 0).sort();
    let longest = 0, run = 0, prev: Date | null = null;
    for (const d of days) {
      const dt = parseDay(d);
      run = prev && (dt.getTime() - prev.getTime()) === 86400000 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = dt;
    }
    let current = 0;
    let cur = parseDay(today);
    if (!counts[today]) cur = addDays(cur, -1); // today not studied yet doesn't break the streak
    while (counts[fmtDay(cur)] > 0) { current++; cur = addDays(cur, -1); }
    const yearDays = days.filter(d => d.startsWith(String(year)));
    const busiest = yearDays.reduce<[string, number] | null>((b, d) => (!b || counts[d] > b[1] ? [d, counts[d]] : b), null);
    return { current, longest, active: yearDays.length, busiest };
  }, [counts, today, year]);

  const idx = years.indexOf(year);
  const fmtLong = (s: string) => parseDay(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  return (
    <ChartCard title="Calendar" subtitle={quizlet && anki ? 'Anki reviews and Quizlet answers per day' : 'Reviews per day'}
      actions={
        <div className="flex items-center gap-1 text-sm">
          <button className="icon-btn disabled:opacity-30" disabled={idx >= years.length - 1} onClick={() => setYear(years[idx + 1])} aria-label="Previous year">‹</button>
          <span className="tabular-nums w-12 text-center">{year}</span>
          <button className="icon-btn disabled:opacity-30" disabled={idx <= 0} onClick={() => setYear(years[idx - 1])} aria-label="Next year">›</button>
        </div>
      }
      table={{ columns: ['Day', 'Reviews'], rows: Object.keys(counts).filter(d => d.startsWith(String(year)) && counts[d] > 0).sort().reverse().map(d => [fmtLong(d), fmtInt(counts[d])]) }}
      summary={<>
        <S k="Current streak" v={`${current} ${current === 1 ? 'day' : 'days'}`} />
        <S k="Longest streak" v={`${longest} days`} />
        <S k={`Days studied in ${year}`} v={fmtInt(active)} />
        {busiest && <S k="Busiest day" v={`${fmtInt(busiest[1])} (${parseDay(busiest[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })})`} />}
      </>}>
      <div className="relative overflow-x-auto pb-1" onMouseLeave={() => setHover(null)}>
        <div className="inline-flex gap-[3px] min-w-max">
          <div className="flex flex-col gap-[3px] mr-1 pt-4 text-[10px] text-(--text-secondary)">
            {['Mon', '', 'Wed', '', 'Fri', '', ''].map((l, i) => <span key={i} className="h-[11px] leading-[11px]">{l}</span>)}
          </div>
          {weeks.map((col, w) => {
            const first = col.find(c => c.inYear && c.d.getUTCDate() === 1);
            return (
              <div key={w} className="flex flex-col gap-[3px]">
                <span className="h-[13px] text-[10px] text-(--text-secondary) whitespace-nowrap">
                  {first ? first.d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) : ''}
                </span>
                {col.map(({ d, inYear }) => {
                  const ds = fmtDay(d);
                  const n = counts[ds] ?? 0;
                  const future = ds > today;
                  return (
                    <span key={ds}
                      onMouseEnter={e => { if (!inYear) return; const r = (e.target as HTMLElement).getBoundingClientRect(); const p = (e.currentTarget.closest('.relative') as HTMLElement).getBoundingClientRect(); setHover({ d: ds, n, x: r.left - p.left + 6, y: r.top - p.top }); }}
                      className={`w-[11px] h-[11px] rounded-[3px] ${inYear ? '' : 'opacity-0'} ${ds === today ? 'ring-1 ring-white/60' : ''}`}
                      style={{ background: future ? 'transparent' : shade(n), outline: future && inYear ? '1px solid rgba(255,255,255,0.06)' : undefined }} />
                  );
                })}
              </div>
            );
          })}
        </div>
        {hover && (
          <div className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full" style={{ left: hover.x, top: hover.y - 4 }}>
            <TipBox title={fmtLong(hover.d)} rows={[{ label: hover.n === 1 ? 'review' : 'reviews', value: fmtInt(hover.n) }]} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-(--text-secondary)">
        Less {[0, levels[0], levels[1], levels[2], levels[2] + 1].map((v, i) => <span key={i} className="w-[11px] h-[11px] rounded-[3px]" style={{ background: shade(i === 0 ? 0 : Math.max(1, v)) }} />)} More
      </div>
    </ChartCard>
  );
}

// --- Card counts ---------------------------------------------------------------

function CountRows({ rows, total }: { rows: { label: string; n: number; color: string }[]; total: number }) {
  return (
    <div className="space-y-2.5">
      {rows.map(r => (
        <div key={r.label} className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-3 text-sm">
          <span className="flex items-center gap-2 text-(--text-secondary)"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: r.color }} />{r.label}</span>
          <div className="h-2 rounded-full bg-(--bg-tertiary)/60 overflow-hidden" title={`${r.label}: ${fmtInt(r.n)}`}>
            <div className="h-full rounded-full" style={{ width: `${total ? (r.n / total) * 100 : 0}%`, minWidth: r.n ? 4 : 0, background: r.color }} />
          </div>
          <span className="text-right tabular-nums"><span className="font-medium">{fmtInt(r.n)}</span> <span className="text-xs text-(--text-secondary)">{pct(r.n, total)}</span></span>
        </div>
      ))}
    </div>
  );
}

export function CardCounts({ anki, quizlet }: { anki: AnkiStats | null; quizlet: QuizletStats | null }) {
  const cc = anki?.card_counts;
  const ankiRows = cc ? [
    { label: 'New', n: cc.new, color: C.new }, { label: 'Learning', n: cc.learning, color: C.learning },
    { label: 'Relearning', n: cc.relearning, color: C.relearning }, { label: 'Young', n: cc.young, color: C.young },
    { label: 'Mature', n: cc.mature, color: C.mature }, { label: 'Suspended', n: cc.suspended, color: C.suspended },
    { label: 'Buried', n: cc.buried, color: C.buried },
  ].filter(r => r.n > 0 || ['New', 'Young', 'Mature'].includes(r.label)) : [];
  const m = quizlet?.mastery;
  const qRows = m ? [
    { label: 'Not studied', n: m.not_studied, color: C.new }, { label: 'Still learning', n: m.learning, color: C.learning },
    { label: 'Familiar', n: m.familiar, color: C.young }, { label: 'Mastered', n: m.mastered, color: C.mature },
  ] : [];
  return (
    <ChartCard title="Card counts" subtitle="Mature = interval of 21 days or more"
      table={{ columns: ['State', 'Cards', 'Share'], rows: [...ankiRows.map(r => [`Anki · ${r.label}`, fmtInt(r.n), pct(r.n, cc!.total)]), ...qRows.map(r => [`Quizlet · ${r.label}`, fmtInt(r.n), pct(r.n, m!.total)])] }}
      summary={<>{cc && <S k="Anki total" v={fmtInt(cc.total)} />}{m && <S k="Quizlet terms" v={fmtInt(m.total)} />}</>}>
      {cc && <CountRows rows={ankiRows} total={cc.total} />}
      {m && m.total > 0 && (
        <div className={cc ? 'pt-4 border-t border-white/8 space-y-3' : 'space-y-3'}>
          {cc && <p className="text-xs font-semibold uppercase tracking-wider text-(--text-secondary)">Quizlet · Learn progress</p>}
          <CountRows rows={qRows} total={m.total} />
        </div>
      )}
    </ChartCard>
  );
}

// --- Histograms: intervals, ease, added -------------------------------------------

function Histogram({ data, color = 'var(--accent)', unit, height = H }: { data: { label: string; long: string; n: number }[]; color?: string; unit: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="label" {...axisProps} minTickGap={14} />
        <YAxis {...yAxisProps} />
        <Tooltip cursor={cursor} content={({ active, payload }) => active && payload?.length
          ? <TipBox title={String(payload[0].payload.long)} rows={[{ label: unit, value: fmtInt(Number(payload[0].payload.n)) }]} /> : null} />
        <Bar dataKey="n" fill={color} radius={BAR_RADIUS} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Intervals({ anki, period }: { anki: AnkiStats; period: StatsPeriod }) {
  const entries = Object.entries(anki.intervals).map(([k, v]) => [Number(k), v] as const);
  const n = entries.reduce((a, [, v]) => a + v, 0);
  const avg = n ? entries.reduce((a, [k, v]) => a + k * v, 0) / n : 0;
  const longest = entries.length ? Math.max(...entries.map(([k]) => k)) : 0;
  const range = PERIOD_DAYS[period] ?? Math.max(31, longest);
  const step = range <= 31 ? 1 : range <= 91 ? 7 : range <= 365 ? 30 : Math.ceil(range / 24 / 30) * 30;
  const buckets: { label: string; long: string; n: number }[] = [];
  for (let lo = 1; lo <= range; lo += step) {
    const hi = Math.min(lo + step - 1, range);
    buckets.push({ label: step === 1 ? fmtIvl(lo) : `${fmtIvl(lo)}`, long: step === 1 ? `${lo} day${lo > 1 ? 's' : ''}` : `${fmtIvl(lo)} – ${fmtIvl(hi)}`, n: 0 });
  }
  let beyond = 0;
  for (const [k, v] of entries) {
    if (k > range) { beyond += v; continue; }
    buckets[Math.min(buckets.length - 1, Math.floor((k - 1) / step))].n += v;
  }
  return (
    <ChartCard title="Review intervals" subtitle="How long until each review card comes back"
      table={{ columns: ['Interval', 'Cards'], rows: [...buckets.map(b => [b.long, fmtInt(b.n)]), ...(beyond ? [[`Longer than ${fmtIvl(range)}`, fmtInt(beyond)]] : [])] }}
      summary={<>
        <S k="Average interval" v={n ? fmtIvl(Math.round(avg)) : '—'} />
        <S k="Longest" v={longest ? fmtIvl(longest) : '—'} />
        {beyond > 0 && <S k={`Beyond ${fmtIvl(range)}`} v={`${fmtInt(beyond)} cards`} />}
      </>}>
      <Histogram data={buckets} unit="cards" />
    </ChartCard>
  );
}

export function Ease({ anki }: { anki: AnkiStats }) {
  const data = Object.entries(anki.ease).map(([k, v]) => ({ label: `${k}%`, long: `${k}% ease`, n: v }));
  return (
    <ChartCard title="Card ease" subtitle="Ease factor of review cards — lower means Anki has seen you struggle"
      table={{ columns: ['Ease', 'Cards'], rows: data.map(d => [d.label, fmtInt(d.n)]) }}
      summary={<S k="Average ease" v={anki.ease_avg ? `${Math.round(anki.ease_avg)}%` : '—'} />}>
      {data.length ? <Histogram data={data} unit="cards" /> : <p className="text-sm text-(--text-secondary)">No ease data — your decks may use FSRS, which Anki doesn’t expose here.</p>}
    </ChartCard>
  );
}

export function Added({ anki, period, today }: { anki: AnkiStats; period: StatsPeriod; today: string }) {
  const bucket = defaultBucket(period);
  const data = bucketize(Object.fromEntries(Object.entries(anki.added).map(([d, n]) => [d, { n }])), today, PERIOD_DAYS[period], bucket)
    .map(b => ({ label: b.label, long: b.long, n: b.values.n ?? 0 }));
  const total = data.reduce((a, d) => a + d.n, 0);
  const span = PERIOD_DAYS[period] ?? Math.max(1, data.length * (bucket === 'month' ? 30 : bucket === 'week' ? 7 : 1));
  return (
    <ChartCard title="Added" subtitle="New Anki cards created"
      table={{ columns: ['Period', 'Cards added'], rows: data.map(d => [d.long, fmtInt(d.n)]) }}
      summary={<><S k="Total" v={fmtInt(total)} /><S k="Average" v={`${(total / span).toFixed(1)}/day`} /></>}>
      <Histogram data={data} unit="added" color={C.new} />
    </ChartCard>
  );
}

// --- Hourly breakdown -------------------------------------------------------------

export function Hourly({ anki, quizlet }: { anki: AnkiStats | null; quizlet: QuizletStats | null }) {
  const data = Array.from({ length: 24 }, (_, h) => {
    const total = (anki?.hourly[h]?.total ?? 0) + (quizlet?.hourly[h]?.total ?? 0);
    const correct = (anki?.hourly[h]?.correct ?? 0) + (quizlet?.hourly[h]?.correct ?? 0);
    const label = new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString(undefined, { hour: 'numeric', timeZone: 'UTC' });
    return { h, label, total, correct, rate: total >= 5 ? (correct / total) * 100 : null };
  });
  const enough = data.filter(d => d.rate != null);
  const best = enough.reduce<typeof data[number] | null>((b, d) => (!b || (d.rate ?? 0) > (b.rate ?? 0) ? d : b), null);
  const busiest = data.reduce((b, d) => (d.total > b.total ? d : b), data[0]);
  return (
    <ChartCard title="Hourly breakdown" subtitle="When you study, and how often you get it right"
      table={{ columns: ['Hour', 'Reviews', 'Correct'], rows: data.map(d => [d.label, fmtInt(d.total), pct(d.correct, d.total)]) }}
      summary={<>
        {busiest.total > 0 && <S k="Busiest hour" v={busiest.label} />}
        {best && <S k="Most accurate" v={`${best.label} (${Math.round(best.rate!)}%)`} />}
      </>}>
      <ResponsiveContainer width="100%" height={170}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} interval={2} />
          <YAxis {...yAxisProps} />
          <Tooltip cursor={cursor} content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as typeof data[number];
            return <TipBox title={d.label} rows={[{ label: 'reviews', value: fmtInt(d.total) }, { label: 'correct', value: pct(d.correct, d.total) }]} />;
          }} />
          <Bar dataKey="total" fill="var(--accent)" radius={BAR_RADIUS} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <div>
        <p className="text-xs text-(--text-secondary) mb-1">% correct (hours with 5+ reviews)</p>
        <ResponsiveContainer width="100%" height={90}>
          <LineChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="label" {...axisProps} interval={2} />
            <YAxis {...yAxisProps} width={40} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={v => `${v}%`} />
            <Tooltip cursor={{ stroke: 'rgba(255,255,255,0.2)' }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as typeof data[number];
              return <TipBox title={d.label} rows={[{ label: 'correct', value: d.rate == null ? 'too few' : `${Math.round(d.rate)}%` }]} />;
            }} />
            <Line dataKey="rate" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

// --- Answer buttons -----------------------------------------------------------------

export function AnswerButtons({ anki }: { anki: AnkiStats }) {
  const groups = [
    { key: 'learning' as const, label: 'Learning' }, { key: 'young' as const, label: 'Young' }, { key: 'mature' as const, label: 'Mature' },
  ];
  const [hover, setHover] = useState<string | null>(null);
  return (
    <ChartCard title="Answer buttons" subtitle="Which buttons you press, by card type"
      table={{ columns: ['Type', ...BUTTONS.map(b => b.label), 'Correct'], rows: groups.map(g => {
        const v = anki.buttons[g.key]; const t = v.reduce((a, b) => a + b, 0);
        return [g.label, ...v.map(fmtInt), pct(t - v[0], t)];
      }) }}>
      <Legend items={BUTTONS.map(b => ({ label: b.label, color: b.color }))} />
      <div className="space-y-4">
        {groups.map(g => {
          const v = anki.buttons[g.key];
          const total = v.reduce((a, b) => a + b, 0);
          return (
            <div key={g.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span>{g.label}</span>
                <span className="text-xs text-(--text-secondary)">{total ? <><span className="text-white font-medium">{pct(total - v[0], total)}</span> correct · {fmtInt(total)} answers</> : 'no answers'}</span>
              </div>
              <div className="flex h-7 gap-[2px] rounded-md overflow-hidden bg-(--bg-tertiary)/40">
                {v.map((n, i) => n > 0 && (
                  <div key={i} className="h-full flex items-center justify-center text-[11px] font-semibold text-white transition-opacity"
                    style={{ width: `${(n / total) * 100}%`, background: BUTTONS[i].color, opacity: hover && hover !== `${g.key}${i}` ? 0.55 : 1 }}
                    onMouseEnter={() => setHover(`${g.key}${i}`)} onMouseLeave={() => setHover(null)}
                    title={`${BUTTONS[i].label}: ${fmtInt(n)} (${pct(n, total)})`}>
                    {n / total >= 0.09 ? pct(n, total) : ''}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}

// --- True retention -------------------------------------------------------------------

export function Retention({ anki }: { anki: AnkiStats }) {
  const rows: [keyof AnkiStats['retention'], string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last week'], ['month', 'Last month'], ['year', 'Last year'], ['all', 'All time']];
  const cell = (pass: number, fail: number) => {
    const t = pass + fail;
    return t
      ? <><span className="font-medium text-white">{pct(pass, t, 1)}</span><span className="text-(--text-secondary) block sm:inline text-xs sm:text-sm"><span className="hidden sm:inline"> · </span>{fmtInt(t)}</span></>
      : <span className="text-(--text-secondary)">—</span>;
  };
  return (
    <ChartCard title="True retention" subtitle="Share of review-card answers that weren’t “Again” (first answer per card per day)">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-(--text-secondary)">
            <th className="text-left font-medium pb-2"> </th><th className="text-right font-medium pb-2">Young</th><th className="text-right font-medium pb-2">Mature</th><th className="text-right font-medium pb-2">Total</th>
          </tr></thead>
          <tbody>
            {rows.map(([k, label]) => {
              const r = anki.retention[k];
              return (
                <tr key={k} className="border-t border-white/5">
                  <td className="py-2 text-(--text-secondary)">{label}</td>
                  <td className="py-2 text-right tabular-nums">{cell(r.young_pass, r.young_fail)}</td>
                  <td className="py-2 text-right tabular-nums">{cell(r.mature_pass, r.mature_fail)}</td>
                  <td className="py-2 text-right tabular-nums">{cell(r.young_pass + r.mature_pass, r.young_fail + r.mature_fail)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

// --- Quizlet ---------------------------------------------------------------------------

export function QuizletInsights({ quizlet }: { quizlet: QuizletStats }) {
  const a = quizlet.accuracy;
  return (
    <ChartCard title="Quizlet · terms to work on" subtitle="Most-missed terms in this period, across Learn, Test and the games"
      summary={<><S k="Answers" v={fmtInt(a.total)} /><S k="Correct" v={pct(a.correct, a.total)} /></>}>
      {quizlet.hardest.length === 0
        ? <p className="text-sm text-(--text-secondary)">No missed terms in this period — nice.</p>
        : <DataTable align={['left', 'left', 'right', 'right']} data={{ columns: ['Term', 'Definition', 'Missed', 'Correct'], rows: quizlet.hardest.map(h => [strip(h.front), strip(h.back), `${h.misses} of ${h.attempts}`, pct(h.attempts - h.misses, h.attempts)]) }} />}
    </ChartCard>
  );
}

const strip = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
