import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wand2, Settings2, Loader2, Star, BookOpen, RefreshCw, Shuffle, X, ChevronDown, Sparkles, AlertTriangle, Search as SearchIcon, Layers, GalleryVerticalEnd, PencilLine } from 'lucide-react';
import { decks, quizlet as quizletApi, settings, story as storyApi, type DeckWordsResponse, type ProviderInfo, type WordData } from '../api';
import { Segmented, Toggle } from './quizlet/ui';
import { AiPanel, Select, type AiChoice } from './story/AiPanel';
import { buildVocab, paragraphs, splitLine } from './story/text';

type Source = 'anki' | 'quizlet' | 'custom';
type Cat = 'new' | 'learning' | 'relearning' | 'young' | 'mature';

const LANGUAGES = ['French', 'Japanese', 'German', 'Spanish', 'Italian', 'Portuguese', 'English', 'Korean', 'Chinese', 'Russian', 'Dutch'];
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
const STYLES = [
  { value: 'casual', label: 'Everyday' }, { value: 'funny', label: 'Funny' }, { value: 'adventure', label: 'Adventure' },
  { value: 'dramatic', label: 'Dramatic' }, { value: 'mystery', label: 'Mystery' }, { value: 'educational', label: 'Informative' },
  { value: 'formal', label: 'Formal' }, { value: 'custom', label: 'Custom…' },
];
const CAT_COLOR: Record<Cat, string> = { new: '#3987e5', learning: '#d95926', relearning: '#e66767', young: '#199e70', mature: '#008300' };
const CAT_LABEL: Record<Source, Partial<Record<Cat, string>>> = {
  anki: { learning: 'Learning', relearning: 'Relearning', young: 'Young', mature: 'Mature', new: 'New' },
  quizlet: { learning: 'Still learning', young: 'Familiar', mature: 'Mastered', new: 'Not studied' },
  custom: {},
};
const DEFAULT_WEIGHTS: Record<Cat, number> = { learning: 5, relearning: 4, young: 2, mature: 1, new: 2 };

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

interface Prefs {
  source: Source; deck: string; set: string; side: 'term' | 'definition'; field: string;
  mode: 'weighted' | 'manual'; count: number; weights: Record<Cat, number>;
  /** Quizlet smart pick: starred terms first / most-missed terms first. */
  qStarred: boolean; qMissed: boolean;
  language: string; level: string; translation: string; length: string; style: string;
}
const DEFAULT_PREFS: Prefs = {
  source: 'anki', deck: '', set: '', side: 'term', field: '', mode: 'weighted', count: 15, weights: DEFAULT_WEIGHTS,
  qStarred: true, qMissed: true,
  language: '', level: 'B1', translation: '', length: 'auto', style: 'casual',
};

/** Pick `count` words, giving categories (learning, young…) shares proportional to their weights. */
function pickWeighted(data: DeckWordsResponse, weights: Record<Cat, number>, count: number): string[] {
  const by: Record<string, string[]> = {};
  for (const w of data.words) (by[data.categories[w] ?? 'new'] ??= []).push(w);
  const cats = (Object.keys(weights) as Cat[]).filter(c => weights[c] > 0).sort((a, b) => weights[b] - weights[a]);
  const total = cats.reduce((n, c) => n + weights[c], 0);
  if (!total) return [];
  const take: Record<string, number> = {};
  let left = count;
  for (const c of cats) { take[c] = Math.min(Math.ceil((weights[c] / total) * count), by[c]?.length ?? 0, left); left -= take[c]; }
  for (const c of cats) { const more = Math.min((by[c]?.length ?? 0) - take[c], left); if (more > 0) { take[c] += more; left -= more; } }
  return cats.flatMap(c => [...(by[c] ?? [])].sort(() => Math.random() - 0.5).slice(0, take[c]));
}

type Words = DeckWordsResponse & { starred?: string[]; missed?: Record<string, number> };
const MAX_WORDS = 150;
const shuffled = <T,>(a: T[]) => [...a].sort(() => Math.random() - 0.5);

/** Quizlet sets have no card states: starred terms first, then the ones you miss most, then random. */
function pickQuizlet(data: Words, starredFirst: boolean, missedFirst: boolean, count: number): string[] {
  const out: string[] = [];
  const add = (ws: string[]) => { for (const w of ws) if (out.length < count && !out.includes(w)) out.push(w); };
  if (starredFirst) add(shuffled(data.starred ?? []));
  if (missedFirst) add(Object.entries(data.missed ?? {}).sort((a, b) => b[1] - a[1]).map(([w]) => w));
  add(shuffled(data.words));
  return out;
}

function pick(source: Source, data: Words, p: Prefs): string[] {
  return source === 'quizlet' ? pickQuizlet(data, p.qStarred, p.qMissed, p.count) : pickWeighted(data, p.weights, p.count);
}

export function Story() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<Prefs>(() => store.get('story-prefs', DEFAULT_PREFS));
  const set = (p: Partial<Prefs>) => setPrefs(prev => { const next = { ...prev, ...p }; store.set('story-prefs', next); return next; });

  const [ankiDecks, setAnkiDecks] = useState<string[]>([]);
  const [sets, setSets] = useState<{ id: number; title: string; card_count: number }[]>([]);
  const [words, setWords] = useState<{ key: string; data: Words } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [filter, setFilter] = useState('');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [lookupFields, setLookupFields] = useState<string[]>([]);

  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({});
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [ai, setAi] = useState<AiChoice>(() => store.get('story-ai', { provider: '', model: '' }));
  const [showAi, setShowAi] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: number; title: string; story: string; forms: Record<string, string[]>; by: string } | null>(null);

  const loadProviders = () => Promise.all([settings.getProviders(), settings.getApiKeys()]).then(([p, k]) => {
    setProviders(p.providers); setConfigured(k.configured);
    setAi(cur => {
      if (cur.provider && k.configured[cur.provider]) return cur;
      const first = Object.keys(p.providers).find(id => k.configured[id]);
      return first ? { provider: first, model: p.providers[first].default_model } : { provider: '', model: '' };
    });
  }).catch(() => {});

  useEffect(() => {
    decks.list().then(d => setAnkiDecks(Object.keys(d.decks).sort((a, b) => a.localeCompare(b)))).catch(() => {});
    quizletApi.listDecks().then(d => setSets(d.decks.map(x => ({ id: x.id, title: x.title, card_count: x.card_count })))).catch(() => {});
    loadProviders();
  }, []);
  useEffect(() => { store.set('story-ai', ai); }, [ai]);

  // Load the words of the chosen deck/set.
  const wordsKey = prefs.source === 'anki' ? `a:${prefs.deck}:${prefs.field}` : prefs.source === 'quizlet' ? `q:${prefs.set}:${prefs.side}` : '';
  useEffect(() => {
    if (prefs.source === 'custom' || (prefs.source === 'anki' && !prefs.deck) || (prefs.source === 'quizlet' && !prefs.set)) return;
    let cancelled = false;
    const req = prefs.source === 'anki' ? decks.getWords(prefs.deck, 500, prefs.field) : quizletApi.getWords(Number(prefs.set), prefs.side);
    req.then(data => {
      if (cancelled) return;
      setWords({ key: wordsKey, data });
      setLookupFields(data.available_fields.filter(f => f !== data.field_used).slice(0, 2));
      setSelected(prefs.mode === 'weighted' ? pick(prefs.source, data, prefs) : data.words.slice(0, prefs.count));
    }).catch(() => { if (!cancelled) setWords({ key: wordsKey, data: { words: [], word_data: {}, total: 0, field_used: null, available_fields: [], categories: {}, category_counts: {} as DeckWordsResponse['category_counts'] } }); });
    return () => { cancelled = true; };
    // Re-pick only when the source changes; weight/count changes re-pick below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordsKey]);

  const data = prefs.source !== 'custom' && words?.key === wordsKey ? words.data : null;
  const loadingWords = prefs.source !== 'custom' && !!(prefs.source === 'anki' ? prefs.deck : prefs.set) && !data;

  const repick = (p: Partial<Prefs> = {}) => {
    const next = { ...prefs, ...p };
    set(p);
    if (data && next.mode === 'weighted') setSelected(pick(next.source, data, next));
  };

  const extraWords = extra.split(/[,\n;]/).map(w => w.trim()).filter(Boolean);
  const allWords = useMemo(() => [...new Set([...(prefs.source === 'custom' ? [] : selected), ...extraWords])], [selected, extraWords, prefs.source]);

  const generate = async () => {
    if (!allWords.length) { setError('Pick some words first.'); return; }
    if (!ai.provider) { setShowAi(true); return; }
    setBusy(true); setError(null);
    try {
      const wordData: Record<string, WordData> = {};
      for (const w of allWords) if (data?.word_data[w]) wordData[w] = data.word_data[w];
      const translate = !!(prefs.translation && prefs.language);
      const sourceName = prefs.source === 'anki' ? prefs.deck : prefs.source === 'quizlet' ? `Quizlet · ${sets.find(s => String(s.id) === prefs.set)?.title ?? ''}` : undefined;
      const r = await storyApi.generate({
        words: allWords, wordData,
        style: prefs.style, customInstructions: prefs.style === 'custom' ? instructions : undefined,
        length: prefs.length,
        language: translate ? prefs.translation : (prefs.language || 'auto'),
        targetLanguage: translate ? prefs.language : undefined,
        level: prefs.level || undefined,
        provider: ai.provider, model: ai.model || undefined,
        deckName: sourceName, name: title.trim() || undefined,
        lookupFields: lookupFields.length ? lookupFields : undefined,
      });
      setResult({ id: r.story_id, title: r.title ?? 'Your story', story: r.story, forms: r.word_forms ?? {}, by: [r.provider_used, r.model_used].filter(Boolean).join(' · ') });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not write the story');
    } finally { setBusy(false); }
  };

  const catLabels = CAT_LABEL[prefs.source];
  const counts = data?.category_counts ?? {};
  const shown = data ? data.words.filter(w => !filter || w.toLowerCase().includes(filter.toLowerCase())) : [];
  const providerName = providers[ai.provider]?.name;

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-24 lg:pb-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Story</h2>
          <p className="text-sm text-(--text-secondary) mt-0.5">Turn the words you’re learning into a short story, then read it in Reading.</p>
        </div>
        <button onClick={() => setShowAi(true)} className="h-9 px-3 rounded-lg bg-(--bg-tertiary) text-sm text-(--text-secondary) hover:text-white inline-flex items-center gap-2 shrink-0 transition-colors">
          <Settings2 className="w-4 h-4" /> <span className="hidden sm:inline">AI settings</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          {/* ── Words ─────────────────────────────── */}
          <section className="card space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Words</h3>
              <span className="text-xs text-(--text-secondary)">{allWords.length} selected</span>
            </div>
            <Segmented full value={prefs.source} onChange={v => set({ source: v })} size="md" options={[
              { value: 'anki', label: 'Anki deck', icon: <Layers className="w-4 h-4" /> },
              { value: 'quizlet', label: 'Quizlet set', icon: <GalleryVerticalEnd className="w-4 h-4" /> },
              { value: 'custom', label: 'My words', icon: <PencilLine className="w-4 h-4" /> },
            ]} />

            {prefs.source === 'anki' && (
              <div className={`grid grid-cols-1 gap-2 ${data && data.available_fields.length > 1 ? 'sm:grid-cols-[1fr_auto]' : ''}`}>
                <Select value={prefs.deck} onChange={v => set({ deck: v, field: '' })} placeholder="Choose a deck…"
                  options={ankiDecks.map(d => ({ value: d, label: d.replace(/::/g, ' › ') }))} />
                {data && data.available_fields.length > 1 && (
                  <Select value={prefs.field} onChange={v => set({ field: v })} placeholder={`Field: ${data.field_used ?? 'auto'}`}
                    options={data.available_fields.map(f => ({ value: f, label: `Field: ${f}` }))} />
                )}
              </div>
            )}
            {prefs.source === 'quizlet' && (
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-center">
                <Select value={prefs.set} onChange={v => set({ set: v })} placeholder={sets.length ? 'Choose a set…' : 'No Quizlet sets yet'}
                  options={sets.map(s => ({ value: String(s.id), label: `${s.title} (${s.card_count})` }))} />
                <Segmented size="field" value={prefs.side} onChange={v => set({ side: v })} options={[{ value: 'term', label: 'Terms' }, { value: 'definition', label: 'Definitions' }]} />
              </div>
            )}

            {prefs.source !== 'custom' && (loadingWords ? (
              <div className="space-y-2">{[0, 1].map(i => <div key={i} className="skeleton h-9 rounded-lg" />)}</div>
            ) : data && (data.words.length === 0 ? (
              <p className="text-sm text-(--text-secondary)">No words found here.</p>
            ) : (
              <div className="space-y-4">
                <Segmented full value={prefs.mode} onChange={v => repick({ mode: v })}
                  options={[{ value: 'weighted', label: 'Smart pick' }, { value: 'manual', label: 'Choose myself' }]} />
                {prefs.mode === 'weighted' ? (
                  <div className="space-y-3">
                    <label className="block">
                      <div className="flex justify-between text-sm mb-1"><span>How many words</span><span className="tabular-nums font-medium">{prefs.count}</span></div>
                      <input type="range" min={Math.min(3, data.words.length)} max={Math.min(MAX_WORDS, data.words.length)} value={Math.min(prefs.count, data.words.length)}
                        onChange={e => repick({ count: Number(e.target.value) })} className="w-full accent-(--accent)" />
                    </label>
                    {prefs.source === 'quizlet' ? (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span>Starred terms first <span className="text-xs text-(--text-secondary)">· {data.starred?.length ?? 0} starred</span></span>
                          <Toggle on={prefs.qStarred} disabled={!data.starred?.length} onChange={v => repick({ qStarred: v })} />
                        </div>
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span>Terms I miss most first <span className="text-xs text-(--text-secondary)">· {Object.keys(data.missed ?? {}).length} missed</span></span>
                          <Toggle on={prefs.qMissed} disabled={!Object.keys(data.missed ?? {}).length} onChange={v => repick({ qMissed: v })} />
                        </div>
                        <p className="text-xs text-(--text-secondary)">The rest are picked at random from the set.</p>
                      </div>
                    ) : <p className="text-xs text-(--text-secondary)">Favour words you’re still learning:</p>}
                    {prefs.source === 'anki' && (Object.keys(catLabels) as Cat[]).filter(c => (counts as Record<string, number>)[c]).map(c => (
                      <label key={c} className="grid grid-cols-[8rem_1fr_2rem] items-center gap-3 text-sm">
                        <span className="flex items-center gap-2 text-(--text-secondary)">
                          <span className="w-2 h-2 rounded-full" style={{ background: CAT_COLOR[c] }} />{catLabels[c]}
                          <span className="text-xs opacity-70">{(counts as Record<string, number>)[c] ?? 0}</span>
                        </span>
                        <input type="range" min={0} max={5} value={prefs.weights[c]} onChange={e => repick({ weights: { ...prefs.weights, [c]: Number(e.target.value) } })}
                          className="w-full accent-(--accent)" />
                        <span className="text-right tabular-nums text-xs text-(--text-secondary)">{prefs.weights[c]}</span>
                      </label>
                    ))}
                    <button onClick={() => repick()} className="text-xs text-(--text-secondary) hover-accent inline-flex items-center gap-1.5"><Shuffle className="w-3.5 h-3.5" /> Pick again</button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <div className="relative flex-1 min-w-0">
                        <SearchIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-(--text-secondary) pointer-events-none" />
                        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter words" className="input w-full h-9 !py-0 !pl-9 text-sm" />
                      </div>
                      <button onClick={() => setSelected(data.words.slice())} className="h-9 px-3 rounded-lg bg-(--bg-tertiary) text-xs text-(--text-secondary) hover:text-white">All</button>
                      <button onClick={() => setSelected([])} className="h-9 px-3 rounded-lg bg-(--bg-tertiary) text-xs text-(--text-secondary) hover:text-white">None</button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-64 overflow-y-auto p-0.5">
                      {shown.map(w => {
                        const on = selected.includes(w);
                        const c = (data.categories[w] ?? 'new') as Cat;
                        return (
                          <button key={w} onClick={() => setSelected(s => (on ? s.filter(x => x !== w) : [...s, w]))}
                            className={`h-7 px-2.5 rounded-md text-xs inline-flex items-center gap-1.5 transition-colors ${on ? 'bg-(--accent) text-white' : 'bg-(--bg-tertiary) text-(--text-secondary) hover:text-white'}`}>
                            <WordMark word={w} data={data} source={prefs.source} cat={c} />{w}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {prefs.mode === 'weighted' && selected.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.map(w => (
                      <span key={w} className="h-7 pl-2.5 pr-1 rounded-md text-xs bg-(--bg-tertiary) inline-flex items-center gap-1.5">
                        <WordMark word={w} data={data} source={prefs.source} cat={(data.categories[w] ?? 'new') as Cat} />{w}
                        <button onClick={() => setSelected(s => s.filter(x => x !== w))} className="w-5 h-5 rounded flex items-center justify-center text-(--text-secondary) hover:text-white hover:bg-white/10" aria-label={`Remove ${w}`}><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )))}

            <label className="block space-y-1">
              <span className="text-xs text-(--text-secondary)">{prefs.source === 'custom' ? 'Your words (comma or one per line)' : 'Add more words (optional)'}</span>
              <textarea value={extra} onChange={e => setExtra(e.target.value)} rows={prefs.source === 'custom' ? 4 : 2}
                placeholder="le marché, acheter, la boulangerie" className="input w-full text-sm" />
            </label>
          </section>

          {/* ── Story ─────────────────────────────── */}
          <section className="card space-y-4">
            <h3 className="font-semibold">Story</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Labeled label="Language">
                <Select value={prefs.language} onChange={v => set({ language: v, translation: v ? prefs.translation : '' })} placeholder="Same as the words"
                  options={LANGUAGES.map(l => ({ value: l, label: l }))} />
              </Labeled>
              <Labeled label="Translate each paragraph into" hint={!prefs.language ? 'Choose the story language first' : undefined}>
                <Select value={prefs.translation} onChange={v => set({ translation: v })} placeholder="No translation"
                  options={LANGUAGES.filter(l => l !== prefs.language).map(l => ({ value: l, label: l }))} className={!prefs.language ? 'opacity-50 pointer-events-none' : ''} />
              </Labeled>
            </div>
            <Labeled label="Your level" hint="Keeps grammar and the other words at a level you can follow">
              <Segmented full value={prefs.level || 'any'} onChange={v => set({ level: v === 'any' ? '' : v })}
                options={[...LEVELS.map(l => ({ value: l, label: l })), { value: 'any', label: 'Any' }]} />
            </Labeled>
            <Labeled label="Length">
              <Segmented full value={prefs.length} onChange={v => set({ length: v })}
                options={[{ value: 'auto', label: 'Auto' }, { value: 'short', label: 'Short' }, { value: 'medium', label: 'Medium' }, { value: 'long', label: 'Long' }]} />
            </Labeled>
            <Labeled label="Tone">
              <div className="flex flex-wrap gap-1.5">
                {STYLES.map(s => (
                  <button key={s.value} onClick={() => set({ style: s.value })}
                    className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors ${prefs.style === s.value ? 'bg-(--accent) text-white' : 'bg-(--bg-tertiary) text-(--text-secondary) hover:text-white'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </Labeled>
            {prefs.style === 'custom' && (
              <textarea value={instructions} onChange={e => setInstructions(e.target.value)} rows={2}
                placeholder="e.g. A detective story set in a Paris bakery, told by the baker’s cat" className="input w-full text-sm" />
            )}
            <Labeled label="Title (optional)">
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Let the AI choose" className="input w-full h-10 !py-0 text-sm" />
            </Labeled>
            {data && data.available_fields.length > 1 && (
              <details className="group text-sm">
                <summary className="cursor-pointer list-none text-xs text-(--text-secondary) hover:text-white inline-flex items-center gap-1">
                  <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" /> Shown when you tap a word in Reading
                </summary>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {data.available_fields.filter(f => f !== data.field_used).map(f => {
                    const on = lookupFields.includes(f);
                    return (
                      <button key={f} onClick={() => setLookupFields(l => (on ? l.filter(x => x !== f) : [...l, f]))}
                        className={`h-7 px-2.5 rounded-md text-xs transition-colors ${on ? 'bg-(--accent) text-white' : 'bg-(--bg-tertiary) text-(--text-secondary) hover:text-white'}`}>{f}</button>
                    );
                  })}
                </div>
              </details>
            )}
          </section>
        </div>

        {/* ── Generate + result ─────────────────────── */}
        <div className="lg:sticky lg:top-4 space-y-4 min-w-0">
          <section className="card space-y-3">
            <button onClick={generate} disabled={busy || !allWords.length}
              className="btn btn-primary w-full h-12 text-base inline-flex items-center justify-center gap-2 disabled:opacity-50">
              {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> Writing your story…</> : <><Wand2 className="w-5 h-5" /> Write story with {allWords.length} {allWords.length === 1 ? 'word' : 'words'}</>}
            </button>
            <button onClick={() => setShowAi(true)} className="w-full text-xs text-(--text-secondary) hover:text-white text-center">
              {providerName ? <>Written by {providerName}{ai.model ? ` · ${ai.model}` : ''} · change</> : <span className="text-(--warning)">Add an AI key to start →</span>}
            </button>
            {error && <p className="text-sm text-(--error) flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{error}</p>}
          </section>

          {busy && !result && (
            <section className="card space-y-3">{[90, 75, 95, 60, 85].map((w, i) => <div key={i} className="skeleton h-4 rounded" style={{ width: `${w}%` }} />)}</section>
          )}
          {result && (
            <section className={`card space-y-4 transition-opacity ${busy ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-bold">{result.title}</h3>
                  {result.by && <p className="text-xs text-(--text-secondary) mt-0.5 flex items-center gap-1"><Sparkles className="w-3 h-3" />{result.by}</p>}
                </div>
                <button onClick={generate} disabled={busy} title="Write another version" className="icon-btn shrink-0"><RefreshCw className="w-4 h-4" /></button>
              </div>
              <StoryPreview text={result.story} words={allWords} forms={result.forms} />
              <button onClick={() => navigate(`/reading?story=${result.id}`)} className="btn btn-primary w-full inline-flex items-center justify-center gap-2">
                <BookOpen className="w-4 h-4" /> Read it with word lookups
              </button>
            </section>
          )}
        </div>
      </div>

      {showAi && (
        <AiPanel providers={providers} configured={configured} choice={ai} onChoice={setAi}
          onKeysChanged={loadProviders} onClose={() => setShowAi(false)} />
      )}
    </div>
  );
}

/** Anki: a dot in the card-state color. Quizlet: a star on starred terms (sets have no card states). */
function WordMark({ word, data, source, cat }: { word: string; data: Words; source: Source; cat: Cat }) {
  if (source === 'quizlet') return data.starred?.includes(word) ? <Star className="w-3 h-3 fill-current text-(--warning)" /> : null;
  return <span className="w-1.5 h-1.5 rounded-full" style={{ background: CAT_COLOR[cat] ?? CAT_COLOR.new }} />;
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-(--text-secondary)">{label}</p>
      {children}
      {hint && <p className="text-[11px] text-(--text-secondary) opacity-80">{hint}</p>}
    </div>
  );
}

function StoryPreview({ text, words, forms }: { text: string; words: string[]; forms: Record<string, string[]> }) {
  const vocab = useMemo(() => buildVocab(words, forms), [words, forms]);
  return (
    <div className="max-h-[55vh] overflow-y-auto space-y-3 pr-1 leading-relaxed">
      {paragraphs(text).map((p, i) => (
        <div key={i} className="space-y-1">
          <p>{splitLine(p.text, vocab).map((x, j) => x.vocab
            ? <mark key={j} className="bg-transparent text-(--accent) font-semibold">{x.text}</mark>
            : <span key={j}>{x.text}</span>)}</p>
          {p.translation && <p className="text-sm text-(--text-secondary) italic">{p.translation}</p>}
        </div>
      ))}
    </div>
  );
}
