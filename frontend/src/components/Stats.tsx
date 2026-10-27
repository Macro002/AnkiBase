import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, ChevronDown, BarChart3 } from 'lucide-react';
import { AnkiPageModal } from './AnkiPage';
import { decks, quizlet as quizletApi, stats, type StatsOverview, type StatsPeriod } from '../api';
import { Segmented } from './quizlet/ui';
import {
  TodaySection, ReviewsChart, FutureDue, CalendarHeatmap, CardCounts, Intervals, Ease, Added,
  Hourly, AnswerButtons, Retention, QuizletInsights,
} from './stats/charts';

/** scope: 'all' | 'anki' | 'quizlet' (everything from one source) | 'a:<deck>' | 'q:<set id>' */
interface Filters { scope: string; period: StatsPeriod }
const DEFAULT_FILTERS: Filters = { scope: 'all', period: '1m' };
const STORE_KEY = 'stats-filters';

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const saved = JSON.parse(raw);
    // Older saves had separate Anki/Quizlet source switches.
    if (saved.scope === 'all' && saved.anki === false) saved.scope = 'quizlet';
    if (saved.scope === 'all' && saved.quizlet === false) saved.scope = 'anki';
    return { scope: saved.scope ?? 'all', period: saved.period ?? '1m' };
  } catch { return DEFAULT_FILTERS; }
}

export function Stats() {
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
  const [deckIds, setDeckIds] = useState<Record<string, number>>({});
  const [ankiStats, setAnkiStats] = useState(false);
  const [quizletSets, setQuizletSets] = useState<{ id: number; title: string }[]>([]);
  const [data, setData] = useState<StatsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // Loading = the data on screen belongs to an older request than the current filters.
  const requestKey = `${JSON.stringify(filters)}#${refreshTick}`;
  const [loadedKey, setLoadedKey] = useState('');
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    decks.list().then(d => {
      setAnkiDecks(Object.keys(d.decks).sort((a, b) => a.localeCompare(b)));
      setDeckIds(d.decks);
    }).catch(() => {});
    quizletApi.listDecks().then(d => setQuizletSets(d.decks.map(x => ({ id: x.id, title: x.title })))).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const { scope, period } = filters;
    const deck = scope.startsWith('a:') ? scope.slice(2) : '';
    const quizletParam = scope.startsWith('q:') ? scope.slice(2) : scope === 'all' || scope === 'quizlet' ? 'all' : 'none';
    const anki = scope.startsWith('a:') || scope === 'all' || scope === 'anki';
    stats.overview({ deck, anki, quizlet: quizletParam, period, refresh: refreshTick > 0 })
      .then(r => { if (!cancelled) { setData(r); setError(null); } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load statistics'); })
      .finally(() => { if (!cancelled) setLoadedKey(requestKey); });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(filters)); } catch { /* storage unavailable */ }
    return () => { cancelled = true; };
  }, [filters, refreshTick, requestKey]);

  const set = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));

  const anki = data?.anki ?? null;
  const qz = data?.quizlet ?? null;
  const first = !data && loading;

  return (
    <div className="space-y-4 pb-8">
      {ankiStats && (() => {
        const deckId = filters.scope.startsWith('a:') ? deckIds[filters.scope.slice(2)] : undefined;
        return <AnkiPageModal title="Anki's statistics" path={deckId ? `graphs?deck=${deckId}` : 'graphs?search='}
          onClose={() => setAnkiStats(false)} />;
      })()}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Statistics</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setAnkiStats(true)} title="The Statistics screen of Anki Desktop"
            className="h-9 px-3 rounded-lg bg-(--bg-tertiary) flex items-center gap-2 text-sm text-(--text-secondary) hover:text-white transition-colors">
            <BarChart3 className="w-4 h-4" />
            Anki's statistics
          </button>
          <button onClick={() => setRefreshTick(t => t + 1)} title="Refresh" disabled={loading}
            className="w-9 h-9 rounded-lg bg-(--bg-tertiary) flex items-center justify-center text-(--text-secondary) hover:text-white transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* One filter row; everything below follows it. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <select value={filters.scope} onChange={e => set({ scope: e.target.value })}
            className="input appearance-none h-9 !py-0 !pl-3 !pr-9 text-sm cursor-pointer max-w-[16rem] truncate">
            <option value="all">Everything</option>
            <option value="anki">Everything in Anki</option>
            <option value="quizlet">Everything in Quizlet</option>
            {ankiDecks.length > 0 && (
              <optgroup label="Anki decks">
                {ankiDecks.map(d => {
                  const depth = d.split('::').length - 1;
                  return <option key={d} value={`a:${d}`}>{'  '.repeat(depth)}{d.split('::').pop()}</option>;
                })}
              </optgroup>
            )}
            {quizletSets.length > 0 && (
              <optgroup label="Quizlet sets">
                {quizletSets.map(s => <option key={s.id} value={`q:${s.id}`}>{s.title}</option>)}
              </optgroup>
            )}
          </select>
          <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-(--text-secondary)" />
        </div>
        <Segmented size="md" value={filters.period} onChange={v => set({ period: v })}
          options={[{ value: '1m', label: '1 month' }, { value: '3m', label: '3 months' }, { value: '1y', label: '1 year' }, { value: 'all', label: 'All' }]} />
      </div>

      {error && <div className="card text-sm text-(--error) flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{error}</div>}
      {data?.anki_error && (
        <div className="card text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-(--warning) shrink-0 mt-0.5" />
          <span><span className="font-medium">Anki stats unavailable.</span> <span className="text-(--text-secondary)">{data.anki_error}</span></span>
        </div>
      )}

      {first ? (
        <div className="space-y-4">
          <p className="text-sm text-(--text-secondary)">Crunching your collection… the first load reads every card, so big collections take a moment.</p>
          {[120, 200, 280].map(h => <div key={h} className="skeleton rounded-xl" style={{ height: h }} />)}
        </div>
      ) : data && (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <TodaySection anki={anki} quizlet={qz} />
          <CalendarHeatmap anki={anki} quizlet={qz} today={data.today} />
          {(anki || qz) && <ReviewsChart anki={anki} quizlet={qz} period={data.period} today={data.today} />}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {anki && <FutureDue anki={anki} period={data.period} today={data.today} />}
            <CardCounts anki={anki} quizlet={qz} />
            {anki && <Intervals anki={anki} period={data.period} />}
            {anki && <Ease anki={anki} />}
            <Hourly anki={anki} quizlet={qz} />
            {anki && <AnswerButtons anki={anki} />}
            {anki && <Retention anki={anki} />}
            {anki && <Added anki={anki} period={data.period} today={data.today} />}
          </div>
          {qz && <QuizletInsights quizlet={qz} />}
          <p className="text-xs text-(--text-secondary) text-center">
            Days start at {data.rollover_hours}:00 (Anki’s default) in your timezone · Mature = interval of 21+ days
          </p>
        </div>
      )}
    </div>
  );
}
