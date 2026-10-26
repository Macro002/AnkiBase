import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon, X, Volume2, ExternalLink, Plus, Pencil, Check, Loader2, ChevronDown, BookOpen, History } from 'lucide-react';
import {
  decks as decksApi, dictionary, quizlet as quizletApi,
  type AnkiHit, type CardSearchResult, type DictEntry, type DictionaryResult, type DictLanguage, type DictSegment, type QuizletHit,
} from '../api';
import { createPortal } from 'react-dom';
import { Segmented } from './quizlet/ui';

const LANGUAGES = ['French', 'Japanese', 'German', 'Spanish', 'Italian', 'Portuguese', 'English', 'Korean', 'Chinese', 'Russian', 'Dutch', 'Latin'];
const RECENT_KEY = 'search-recent';
const LANG_KEY = 'search-language';

// --- small helpers ------------------------------------------------------------

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const stripHtml = (s: string) => s.replace(/\[sound:[^\]]+\]/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/** Fold for matching: lowercase, no accents, œ→oe. Keeps a map back to the original indices. */
function foldWithMap(s: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const f = s[i].toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace('œ', 'oe').replace('æ', 'ae');
    for (const ch of f) { folded += ch; map.push(i); }
  }
  return { folded, map };
}

/** Highlight `q` inside plain text, ignoring case and accents. */
function Highlight({ text, q }: { text: string; q: string }) {
  const parts = useMemo(() => {
    const needle = foldWithMap(q.trim()).folded;
    if (!needle) return [text];
    const { folded, map } = foldWithMap(text);
    const out: (string | { m: string })[] = [];
    let from = 0, at = folded.indexOf(needle);
    while (at !== -1) {
      const start = map[at], end = map[at + needle.length - 1] + 1;
      if (start > from) out.push(text.slice(from, start));
      out.push({ m: text.slice(start, end) });
      from = end;
      at = folded.indexOf(needle, at + needle.length);
    }
    out.push(text.slice(from));
    return out;
  }, [text, q]);
  return <>{parts.map((p, i) => typeof p === 'string' ? p : <mark key={i} className="bg-(--accent)/25 text-white rounded-sm px-0.5">{p.m}</mark>)}</>;
}

function play(url: string) {
  new Audio(url).play().catch(() => {});
}

const STATE_DOT: Record<string, { color: string; label: string }> = {
  new: { color: '#3987e5', label: 'New' }, learning: { color: '#d95926', label: 'Learning' },
  young: { color: '#199e70', label: 'Young' }, mature: { color: '#008300', label: 'Mature' },
  suspended: { color: '#c98500', label: 'Suspended' },
};
const LEVEL_DOT = [STATE_DOT.new, STATE_DOT.learning, { color: '#199e70', label: 'Familiar' }, { color: '#008300', label: 'Mastered' }];
const LEVEL_LABEL = ['Not studied', 'Still learning', 'Familiar', 'Mastered'];

// --- page -------------------------------------------------------------------------

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [lang, setLang] = useState<string>(() => store.get(LANG_KEY, 'French'));
  const [input, setInput] = useState(q);
  const [dict, setDict] = useState<{ key: string; data: DictionaryResult } | null>(null);
  const [cards, setCards] = useState<{ key: string; data: CardSearchResult } | null>(null);
  const [recent, setRecent] = useState<string[]>(() => store.get(RECENT_KEY, []));
  const [adding, setAdding] = useState<{ front: string; back: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const dictKey = `${q}|${lang}`;
  const dictLoading = !!q && dict?.key !== dictKey;
  const cardsLoading = !!q && cards?.key !== q;

  // Keep the box in sync when navigating back/forward.
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) { setLastQ(q); setInput(q); }

  // Typing updates the URL after a short pause (replace, so history isn't spammed).
  useEffect(() => {
    if (input.trim() === q) return;
    const t = setTimeout(() => setParams(input.trim() ? { q: input.trim() } : {}, { replace: true }), 350);
    return () => clearTimeout(t);
  }, [input, q, setParams]);

  const go = (word: string) => {
    const w = word.trim();
    setInput(w);
    setParams(w ? { q: w } : {});   // push: back returns to the previous word
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Your cards: fast, local.
  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    dictionary.searchCards(q).then(data => { if (!cancelled) setCards({ key: q, data }); })
      .catch(() => { if (!cancelled) setCards({ key: q, data: { anki: [], quizlet: [], anki_total: 0, anki_error: 'Search failed' } }); });
    return () => { cancelled = true; };
  }, [q]);

  // Dictionary: remote, so wait a beat longer before asking.
  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    const t = setTimeout(() => {
      dictionary.lookup(q, lang).then(data => {
        if (cancelled) return;
        setDict({ key: `${q}|${lang}`, data });
        if (data.wiktionary?.languages.length || data.jisho.length) {
          setRecent(prev => { const next = [q, ...prev.filter(x => x !== q)].slice(0, 12); store.set(RECENT_KEY, next); return next; });
        }
      }).catch(e => { if (!cancelled) setDict({ key: `${q}|${lang}`, data: { wiktionary: null, jisho: [], error: e instanceof Error ? e.message : 'Lookup failed' } }); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, lang]);

  // "/" focuses the search box from anywhere on the page.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable) {
        e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);

  const showDict = q && dict?.key === dictKey ? dict.data : null;
  const showCards = q && cards?.key === q ? cards.data : null;

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-10">
      {/* Search bar */}
      <form onSubmit={e => { e.preventDefault(); go(input); }} className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-(--text-secondary) pointer-events-none" />
          <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} autoFocus
            placeholder="Look up a word, or find it in your cards…" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            className="input w-full h-12 !pl-12 !pr-20 text-base rounded-xl" />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {input && (
              <button type="button" onClick={() => { setInput(''); setParams({}); inputRef.current?.focus(); }}
                className="w-7 h-7 rounded-md flex items-center justify-center text-(--text-secondary) hover:text-white hover:bg-white/8" aria-label="Clear">
                <X className="w-4 h-4" />
              </button>
            )}
            <kbd className="hidden sm:inline text-[10px] text-(--text-secondary) border border-white/10 rounded px-1.5 py-0.5">/</kbd>
          </div>
        </div>
        <div className="relative shrink-0">
          <select value={lang} onChange={e => { setLang(e.target.value); store.set(LANG_KEY, e.target.value); }}
            className="input appearance-none h-12 !py-0 !pl-3 !pr-9 text-sm rounded-xl cursor-pointer" aria-label="Dictionary language">
            <option value="">Any language</option>
            {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-(--text-secondary)" />
        </div>
      </form>

      {!q ? (
        <EmptyState recent={recent} onPick={go} onClear={() => { setRecent([]); store.set(RECENT_KEY, []); }} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-5 items-start">
          <section className={`transition-opacity ${dictLoading && showDict ? 'opacity-60' : ''}`}>
            {showDict ? (
              <DictionaryPanel data={showDict} lang={lang} onSearch={go} onAdd={setAdding} />
            ) : (
              <div className="card space-y-3">{[60, 20, 90, 70].map((w, i) => <div key={i} className="skeleton h-5 rounded" style={{ width: `${w}%` }} />)}</div>
            )}
          </section>
          <section className={`lg:sticky lg:top-4 transition-opacity ${cardsLoading && showCards ? 'opacity-60' : ''}`}>
            <CardsPanel data={showCards} q={q} onSaved={() => setToast('Saved')} />
          </section>
        </div>
      )}

      {adding && <AddCardDialog prefill={adding} onClose={() => setAdding(null)}
        onAdded={dest => { setAdding(null); setToast(`Added to ${dest}`); dictionary.searchCards(q).then(data => setCards({ key: q, data })).catch(() => {}); }} />}
      {toast && createPortal(
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[300] rounded-lg bg-(--bg-secondary) border border-white/10 shadow-xl px-4 py-2.5 text-sm flex items-center gap-2 section-summary-in">
          <Check className="w-4 h-4 text-green-400" /> {toast}
        </div>, document.body)}
      <style>{`@keyframes sIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } } .section-summary-in { animation: sIn .25s ease-out }`}</style>
    </div>
  );
}

function EmptyState({ recent, onPick, onClear }: { recent: string[]; onPick: (w: string) => void; onClear: () => void }) {
  return (
    <div className="card text-center py-12 space-y-5">
      <BookOpen className="w-10 h-10 mx-auto text-(--text-secondary)" />
      <div>
        <h2 className="text-lg font-semibold">Dictionary & card search</h2>
        <p className="text-sm text-(--text-secondary) mt-1 max-w-md mx-auto">
          Type any word for its meaning, pronunciation and forms (from Wiktionary, plus Jisho for Japanese) —
          and see every Anki note and Quizlet card that already has it. Accents are optional: <i>foret</i> finds <i>forêt</i>.
        </p>
      </div>
      {recent.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-(--text-secondary) flex items-center justify-center gap-1.5"><History className="w-3.5 h-3.5" /> Recent
            <button onClick={onClear} className="hover-accent ml-1">· clear</button></p>
          <div className="flex flex-wrap justify-center gap-2">
            {recent.map(r => (
              <button key={r} onClick={() => onPick(r)} className="px-3 py-1.5 rounded-lg bg-(--bg-tertiary) text-sm hover:bg-(--accent)/15 hover:text-white transition-colors">{r}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- dictionary ------------------------------------------------------------------------

function Segments({ segs, onSearch }: { segs: DictSegment[]; onSearch: (w: string) => void }) {
  return <>{segs.map((s, i) => s.w
    ? <button key={i} onClick={() => onSearch(s.w!)} className="text-(--accent) hover:underline underline-offset-2">{s.t}</button>
    : <span key={i}>{s.t}</span>)}</>;
}

function DictionaryPanel({ data, lang, onSearch, onAdd }: {
  data: DictionaryResult; lang: string; onSearch: (w: string) => void; onAdd: (p: { front: string; back: string }) => void;
}) {
  const w = data.wiktionary;
  const languages = w?.languages ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const active: DictLanguage | undefined = languages.find(l => l.language === picked) ?? languages[0];

  if (data.error && !languages.length && !data.jisho.length) {
    return <div className="card text-sm text-(--text-secondary)">{data.error}</div>;
  }
  if (!languages.length && !data.jisho.length) {
    return (
      <div className="card space-y-2">
        <p className="font-medium">No dictionary entry for “{w?.query ?? ''}”</p>
        <p className="text-sm text-(--text-secondary)">Try the base form (e.g. the infinitive or singular), or check the spelling.</p>
        {w?.variants.length ? <Chips label="Did you mean" words={w.variants} onSearch={onSearch} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.jisho.length > 0 && <JishoCard entries={data.jisho} onAdd={onAdd} />}

      {active && w && (
        <article className="card space-y-5">
          {w.corrected && (
            <p className="text-xs text-(--text-secondary)">Showing <span className="text-white font-medium">{w.word}</span> — no {lang || 'matching'} entry for “{w.query}”.</p>
          )}
          {lang && !languages.some(l => l.language === lang) && (
            <p className="text-xs text-(--text-secondary)">No {lang} entry — showing {active.language}.</p>
          )}
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-bold break-words">{w.word}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-sm">
                {active.ipa.length > 0 && <span className="text-(--text-secondary) font-mono">{active.ipa.join('  ')}</span>}
                {active.audio.length > 0 && (
                  <button onClick={() => play(active.audio[0])} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-(--bg-tertiary) text-xs hover:text-white text-(--text-secondary) transition-colors">
                    <Volume2 className="w-3.5 h-3.5" /> Listen
                  </button>
                )}
              </div>
            </div>
            <a href={w.source_url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-(--text-secondary) hover-accent inline-flex items-center gap-1 mt-2">
              Wiktionary <ExternalLink className="w-3 h-3" />
            </a>
          </header>

          {w.variants.length > 0 && <Chips label={w.corrected ? 'Other spellings' : 'Did you mean'} words={w.variants.slice(0, 6)} onSearch={onSearch} />}

          {languages.length > 1 && active && (
            <Segmented wrap value={active.language} onChange={setPicked}
              options={languages.slice(0, 8).map(l => ({ value: l.language, label: l.language }))} className="!h-auto" />
          )}

          <div className="space-y-6">
            {active.entries.map((e, i) => <Entry key={i} e={e} word={w.word} onSearch={onSearch} onAdd={onAdd} />)}
          </div>

          {active.etymology && (
            <details className="text-sm group">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-(--text-secondary) hover:text-white list-none flex items-center gap-1">
                <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" /> Etymology
              </summary>
              <p className="mt-2 text-(--text-secondary) leading-relaxed">{active.etymology}</p>
            </details>
          )}
        </article>
      )}
    </div>
  );
}

const GENDER: Record<string, string> = { m: 'masculine', f: 'feminine', n: 'neuter', 'm or f': 'masculine or feminine', 'm pl': 'masculine plural', 'f pl': 'feminine plural' };

function Entry({ e, word, onSearch, onAdd }: { e: DictEntry; word: string; onSearch: (w: string) => void; onAdd: (p: { front: string; back: string }) => void }) {
  const head = e.headword || word;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-(--accent)">{e.pos}</span>
        {e.gender && <span className="text-xs px-1.5 py-0.5 rounded bg-(--bg-tertiary) text-(--text-secondary)" title={GENDER[e.gender] ?? e.gender}>{GENDER[e.gender] ?? e.gender}</span>}
        {e.forms.length > 0 && (
          <span className="text-sm text-(--text-secondary)">
            {e.forms.map((f, i) => (
              <span key={i}>{i > 0 && ' · '}{f.label && <i>{f.label} </i>}
                <button onClick={() => onSearch(f.form)} className="text-white hover:text-(--accent) transition-colors">{f.form}</button>
              </span>
            ))}
          </span>
        )}
      </div>
      <ol className="space-y-2.5">
        {e.senses.map((s, i) => {
          const text = s.segments.map(x => x.t).join('');
          return (
            <li key={i} className="group flex gap-3">
              <span className="text-(--text-secondary) tabular-nums text-sm w-5 shrink-0 text-right pt-px">{i + 1}.</span>
              <div className="flex-1 min-w-0 space-y-1">
                <p className="leading-relaxed"><Segments segs={s.segments} onSearch={onSearch} /></p>
                {s.examples.map((x, j) => (
                  <p key={j} className="text-sm border-l-2 border-white/10 pl-3">
                    <span className="italic">{x.text}</span>
                    {x.translation && <span className="block text-(--text-secondary)">{x.translation}</span>}
                  </p>
                ))}
              </div>
              <button onClick={() => onAdd({ front: e.gender && e.pos === 'Noun' ? `${head} (${e.gender})` : head, back: text })}
                title="Add as a card" className="shrink-0 self-start w-7 h-7 rounded-md flex items-center justify-center text-(--text-secondary) hover:text-white hover:bg-(--accent)/20 sm:opacity-0 group-hover:opacity-100 focus:opacity-100 transition">
                <Plus className="w-4 h-4" />
              </button>
            </li>
          );
        })}
      </ol>
      {(['synonyms', 'antonyms', 'related', 'derived'] as const).map(k => e.related[k]?.length
        ? <Chips key={k} label={{ synonyms: 'Synonyms', antonyms: 'Antonyms', related: 'Related', derived: 'Derived' }[k]} words={e.related[k]!.slice(0, 8)} onSearch={onSearch} />
        : null)}
    </div>
  );
}

function Chips({ label, words, onSearch }: { label: string; words: string[]; onSearch: (w: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="text-xs text-(--text-secondary) mr-1">{label}</span>
      {words.map(w => (
        <button key={w} onClick={() => onSearch(w)} className="h-7 px-2.5 rounded-md bg-(--bg-tertiary) text-xs hover:bg-(--accent)/15 hover:text-white transition-colors">{w}</button>
      ))}
    </div>
  );
}

function JishoCard({ entries, onAdd }: { entries: DictionaryResult['jisho']; onAdd: (p: { front: string; back: string }) => void }) {
  return (
    <article className="card space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-(--text-secondary)">Jisho</span>
        <a href={`https://jisho.org/search/${encodeURIComponent(entries[0]?.word ?? '')}`} target="_blank" rel="noreferrer" className="text-xs text-(--text-secondary) hover-accent inline-flex items-center gap-1">jisho.org <ExternalLink className="w-3 h-3" /></a>
      </div>
      {entries.slice(0, 4).map((j, i) => (
        <div key={i} className={`flex gap-4 ${i ? 'pt-4 border-t border-white/8' : ''}`}>
          <div className="shrink-0 text-center w-24">
            {j.reading && j.reading !== j.word && <p className="text-xs text-(--text-secondary)">{j.reading}</p>}
            <p className="text-2xl font-bold">{j.word}</p>
            <div className="flex flex-wrap justify-center gap-1 mt-1.5">
              {j.common && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">common</span>}
              {j.jlpt.map(l => <span key={l} className="text-[10px] px-1.5 py-0.5 rounded bg-(--bg-tertiary) text-(--text-secondary)">{l}</span>)}
            </div>
          </div>
          <ol className="flex-1 min-w-0 space-y-1.5 text-sm">
            {j.senses.map((s, k) => (
              <li key={k} className="group flex gap-2">
                <span className="text-(--text-secondary) w-4 shrink-0 text-right">{k + 1}.</span>
                <div className="flex-1 min-w-0">
                  {s.pos.length > 0 && <p className="text-[11px] text-(--accent)">{s.pos.join(', ')}</p>}
                  <p>{s.glosses.join('; ')}{s.info.length > 0 && <span className="text-(--text-secondary)"> — {s.info.join(', ')}</span>}</p>
                </div>
                <button onClick={() => onAdd({ front: j.word, back: `${j.reading && j.reading !== j.word ? `${j.reading} — ` : ''}${s.glosses.join('; ')}` })}
                  title="Add as a card" className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-(--text-secondary) hover:text-white hover:bg-(--accent)/20 sm:opacity-0 group-hover:opacity-100 transition">
                  <Plus className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </article>
  );
}

// --- your cards ------------------------------------------------------------------------------

function CardsPanel({ data, q, onSaved }: { data: CardSearchResult | null; q: string; onSaved: () => void }) {
  const [source, setSource] = useState<'all' | 'anki' | 'quizlet'>('all');
  const anki = data?.anki ?? [];
  const qz = data?.quizlet ?? [];
  const count = (source !== 'quizlet' ? anki.length : 0) + (source !== 'anki' ? qz.length : 0);
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">In your cards {data && <span className="text-(--text-secondary) font-normal text-sm">· {count}{data.anki_total > anki.length && source !== 'quizlet' ? '+' : ''}</span>}</h2>
        <Segmented value={source} onChange={setSource}
          options={[{ value: 'all', label: 'All' }, { value: 'anki', label: 'Anki' }, { value: 'quizlet', label: 'Quizlet' }]} />
      </div>
      {!data ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-14 rounded-lg" />)}</div>
      ) : count === 0 ? (
        <p className="text-sm text-(--text-secondary) py-4 text-center">Not in any of your {source === 'all' ? 'decks or sets' : source === 'anki' ? 'Anki decks' : 'Quizlet sets'} yet.</p>
      ) : (
        <div className="space-y-1.5 max-h-[70vh] overflow-y-auto -mr-2 pr-2">
          {source !== 'quizlet' && anki.map(h => <AnkiRow key={`a${h.note_id}`} h={h} q={q} onSaved={onSaved} />)}
          {source !== 'anki' && qz.map(h => <QuizletRow key={`q${h.id}`} h={h} q={q} onSaved={onSaved} />)}
        </div>
      )}
      {data?.anki_error && source !== 'quizlet' && <p className="text-xs text-(--text-secondary)">Anki isn’t reachable — showing Quizlet only.</p>}
    </div>
  );
}

function RowShell({ front, back, q, badge, dot, children, open, setOpen }: {
  front: string; back: string; q: string; badge: string; dot?: { color: string; label: string } | null;
  children: React.ReactNode; open: boolean; setOpen: (v: boolean) => void;
}) {
  return (
    <div className={`rounded-lg transition-colors ${open ? 'bg-(--bg-tertiary)/70' : 'hover:bg-(--bg-tertiary)/50'}`}>
      <button onClick={() => setOpen(!open)} className="w-full text-left px-3 py-2.5 flex gap-3 items-start">
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate"><Highlight text={front} q={q} /></p>
          <p className="text-sm text-(--text-secondary) truncate"><Highlight text={back} q={q} /></p>
        </div>
        <div className="shrink-0 text-right max-w-[45%]">
          <p className="text-[11px] text-(--text-secondary) truncate">{badge}</p>
          {dot && <p className="text-[11px] flex items-center justify-end gap-1 mt-0.5"><span className="w-1.5 h-1.5 rounded-full" style={{ background: dot.color }} />{dot.label}</p>}
        </div>
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
}

function EditableField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const plain = stripHtml(value);
  return (
    <div className="group/f">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-secondary)">{label}</span>
        {!editing && (
          <button onClick={() => { setDraft(value); setEditing(true); }} className="opacity-60 group-hover/f:opacity-100 text-(--text-secondary) hover:text-white" title="Edit">
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5 mt-1">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 50)))} autoFocus
            className="input w-full text-sm font-mono py-2" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="btn btn-secondary text-xs py-1 px-3">Cancel</button>
            <button disabled={saving} onClick={async () => { setSaving(true); try { await onSave(draft); setEditing(false); } finally { setSaving(false); } }}
              className="btn btn-primary text-xs py-1 px-3 inline-flex items-center gap-1">{saving && <Loader2 className="w-3 h-3 animate-spin" />}Save</button>
          </div>
        </div>
      ) : (
        <p className="text-sm mt-0.5 break-words">{plain || <span className="text-(--text-secondary)">—</span>}</p>
      )}
    </div>
  );
}

function AnkiRow({ h, q, onSaved }: { h: AnkiHit; q: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState(h.fields);
  const navigate = useNavigate();
  const deckLeaf = h.deck?.split('::').pop() ?? 'Anki';
  return (
    <RowShell front={stripHtml(fields[0]?.value ?? '')} back={stripHtml(fields[1]?.value ?? '')} q={q} open={open} setOpen={setOpen}
      badge={`Anki · ${deckLeaf}`} dot={h.state ? STATE_DOT[h.state] : null}>
      {fields.map((f, i) => (
        <EditableField key={f.name} label={f.name} value={f.value} onSave={async v => {
          await dictionary.updateNote(h.note_id, { [f.name]: v });
          setFields(prev => prev.map((x, j) => (j === i ? { ...x, value: v } : x)));
          onSaved();
        }} />
      ))}
      <div className="flex items-center justify-between pt-1 text-xs text-(--text-secondary)">
        <span className="truncate">{h.deck} · {h.model}</span>
        {h.deck_id && <button onClick={() => navigate(`/anki/${h.deck_id}/study`)} className="hover-accent shrink-0 ml-2">Study deck →</button>}
      </div>
    </RowShell>
  );
}

function QuizletRow({ h, q, onSaved }: { h: QuizletHit; q: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState(h);
  const navigate = useNavigate();
  const save = async (front: string, back: string) => {
    await quizletApi.updateCard(card.deck_id, card.id, front, back, card.image);
    setCard(c => ({ ...c, front, back }));
    onSaved();
  };
  return (
    <RowShell front={stripHtml(card.front)} back={stripHtml(card.back)} q={q} open={open} setOpen={setOpen}
      badge={`Quizlet · ${card.title}`} dot={{ ...LEVEL_DOT[card.level] ?? LEVEL_DOT[0], label: LEVEL_LABEL[card.level] ?? LEVEL_LABEL[0] }}>
      <EditableField label="Term" value={card.front} onSave={v => save(v, card.back)} />
      <EditableField label="Definition" value={card.back} onSave={v => save(card.front, v)} />
      <div className="flex justify-end pt-1 text-xs">
        <button onClick={() => navigate(`/quizlet/${card.deck_id}/study`)} className="text-(--text-secondary) hover-accent">Open set →</button>
      </div>
    </RowShell>
  );
}

// --- add card ---------------------------------------------------------------------------------

function AddCardDialog({ prefill, onClose, onAdded }: { prefill: { front: string; back: string }; onClose: () => void; onAdded: (dest: string) => void }) {
  const [front, setFront] = useState(prefill.front);
  const [back, setBack] = useState(prefill.back);
  const [dests, setDests] = useState<{ key: string; label: string; group: string }[] | null>(null);
  const [dest, setDest] = useState<string>(() => store.get('search-add-dest', ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([quizletApi.listDecks().catch(() => ({ decks: [] })), decksApi.list().catch(() => ({ decks: {} as Record<string, number> }))])
      .then(([qz, anki]) => {
        const list = [
          ...qz.decks.map(d => ({ key: `q:${d.id}`, label: d.title, group: 'Quizlet sets' })),
          ...Object.keys(anki.decks).sort().map(n => ({ key: `a:${n}`, label: n.replace(/::/g, ' › '), group: 'Anki decks' })),
        ];
        setDests(list);
        setDest(d => (list.some(x => x.key === d) ? d : list[0]?.key ?? ''));
      });
  }, []);

  const submit = async () => {
    if (!dest || !front.trim() || !back.trim()) return;
    setSaving(true); setError(null);
    try {
      if (dest.startsWith('q:')) await dictionary.addQuizlet(Number(dest.slice(2)), front.trim(), back.trim());
      else await dictionary.addAnki(dest.slice(2), front.trim(), back.trim());
      store.set('search-add-dest', dest);
      onAdded(dests?.find(d => d.key === dest)?.label ?? 'deck');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the card');
    } finally { setSaving(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <form className="bg-(--bg-secondary) rounded-xl max-w-md w-full p-6 space-y-4 section-summary-in" onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); submit(); }}>
        <h3 className="text-lg font-bold">Add as a card</h3>
        <label className="block space-y-1">
          <span className="text-xs text-(--text-secondary)">Front</span>
          <input value={front} onChange={e => setFront(e.target.value)} className="input w-full" autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-(--text-secondary)">Back</span>
          <textarea value={back} onChange={e => setBack(e.target.value)} rows={3} className="input w-full" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-(--text-secondary)">Add to</span>
          <div className="relative">
            <select value={dest} onChange={e => setDest(e.target.value)} className="input w-full appearance-none pr-9 cursor-pointer" disabled={!dests}>
              {!dests && <option>Loading…</option>}
              {dests && ['Quizlet sets', 'Anki decks'].map(g => {
                const items = dests.filter(d => d.group === g);
                return items.length ? <optgroup key={g} label={g}>{items.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}</optgroup> : null;
              })}
            </select>
            <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-(--text-secondary)" />
          </div>
        </label>
        {error && <p className="text-sm text-(--error)">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || !dest} className="btn btn-primary inline-flex items-center gap-2">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Add card</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
