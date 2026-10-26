import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, BookOpen, Check, Languages, Loader2, MoreHorizontal, Pause, Pencil, Play, Plus, Search as SearchIcon,
  Sparkles, Trash2, Volume2, Wand2, X,
} from 'lucide-react';
import {
  dictionary, lookup, media, stories, studySessions,
  type DictionaryResult, type SavedStory, type StoryUnit, type StudySession, type WordData,
} from '../api';
import { useSessionSaver } from '../hooks/useSessionSaver';
import { Segmented } from './quizlet/ui';
import { AddCardDialog } from './AddCardDialog';
import ReactMarkdown from 'react-markdown';
import { alignUnits, buildVocab, fold, LANG_CODE, paragraphs, splitLine, stripArticle, type Vocab } from './story/text';

const clean = (v: string) => v.replace(/\[sound:[^\]]+\]/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const soundOf = (fields: Record<string, string>) => Object.values(fields).map(v => /\[sound:([^\]]+)\]/.exec(v)?.[1]).find(Boolean) ?? null;

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function storyLanguage(s: SavedStory): string | null {
  const l = s.target_language || (s.language && s.language !== 'auto' ? s.language : null);
  return l || null;
}

function speak(text: string, lang: string | null, onEnd?: () => void) {
  if (!('speechSynthesis' in window)) return false;
  const u = new SpeechSynthesisUtterance(text);
  if (lang && LANG_CODE[lang]) u.lang = LANG_CODE[lang];
  u.rate = 0.95;
  if (onEnd) { u.onend = onEnd; u.onerror = onEnd; }
  window.speechSynthesis.speak(u);
  return true;
}

function ago(ts: string): string {
  const t = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return '';
  const d = Math.round((Date.now() - t) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function Reading() {
  const [params, setParams] = useSearchParams();
  const id = Number(params.get('story')) || null;
  return id
    ? <Reader key={id} id={id} onBack={() => setParams({})} />
    : <Library onOpen={sid => setParams({ story: String(sid) })} />;
}

// --- Library ----------------------------------------------------------------------

function Library({ onOpen }: { onOpen: (id: number) => void }) {
  const navigate = useNavigate();
  const [list, setList] = useState<SavedStory[] | null>(null);
  const [progress, setProgress] = useState<Record<string, StudySession>>({});
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedStory | null>(null);

  useEffect(() => {
    stories.list().then(d => setList(d.stories)).catch(() => setList([]));
    studySessions.list().then(d => setProgress(Object.fromEntries(d.sessions.filter(s => s.kind === 'reading').map(s => [s.ref_id, s])))).catch(() => {});
  }, []);
  useEffect(() => {
    if (menu == null) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const shown = (list ?? []).filter(s => !q || fold(`${s.name} ${s.preview ?? ''} ${s.deck_name ?? ''}`).includes(fold(q)));

  const rename = async () => {
    if (!renaming?.name.trim()) return;
    await stories.update(renaming.id, { name: renaming.name.trim() });
    setList(l => l?.map(s => (s.id === renaming.id ? { ...s, name: renaming.name.trim() } : s)) ?? null);
    setRenaming(null);
  };
  const remove = async () => {
    if (!deleting) return;
    await stories.delete(deleting.id);
    setList(l => l?.filter(s => s.id !== deleting.id) ?? null);
    setDeleting(null);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Reading</h2>
          <p className="text-sm text-(--text-secondary) mt-0.5">Your stories — tap any word while reading to look it up.</p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <SearchIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-(--text-secondary) pointer-events-none" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search stories" className="input w-full h-9 !py-0 !pl-9 text-sm" />
          </div>
          <button onClick={() => navigate('/story')} className="btn btn-primary h-9 !py-0 inline-flex items-center gap-2 shrink-0"><Wand2 className="w-4 h-4" /> New story</button>
        </div>
      </div>

      {list == null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{[0, 1, 2].map(i => <div key={i} className="skeleton h-48 rounded-xl" />)}</div>
      ) : list.length === 0 ? (
        <div className="card text-center py-14 space-y-3">
          <BookOpen className="w-10 h-10 mx-auto text-(--text-secondary)" />
          <p className="font-semibold">No stories yet</p>
          <p className="text-sm text-(--text-secondary)">Write one from your Anki or Quizlet words in the Story tab.</p>
          <button onClick={() => navigate('/story')} className="btn btn-primary inline-flex items-center gap-2"><Wand2 className="w-4 h-4" /> Write a story</button>
        </div>
      ) : shown.length === 0 ? (
        <p className="text-sm text-(--text-secondary) text-center py-10">No stories match “{q}”.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 anim-stagger">
          {shown.map(s => {
            const p = progress[String(s.id)];
            const pct = p && p.progress_total ? (p.progress_done / p.progress_total) * 100 : 0;
            const lang = storyLanguage(s);
            const preview = paragraphs(s.preview ?? '')[0]?.text ?? '';
            return (
              <article key={s.id} role="link" tabIndex={0} onClick={() => onOpen(s.id)} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(s.id); }}
                className="group relative rounded-xl bg-(--bg-secondary) hover:bg-(--bg-tertiary) transition-colors p-4 cursor-pointer flex flex-col gap-3 min-h-44">
                <div className="flex items-start gap-2">
                  {renaming?.id === s.id ? (
                    <form className="flex-1 flex gap-1.5" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); rename(); }}>
                      <input autoFocus value={renaming.name} onChange={e => setRenaming({ id: s.id, name: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') setRenaming(null); }}
                        className="input flex-1 min-w-0 h-8 !py-0 text-sm" />
                      <button className="icon-btn" title="Save"><Check className="w-4 h-4" /></button>
                    </form>
                  ) : (
                    <h3 className="font-semibold leading-snug flex-1 min-w-0 line-clamp-2">{s.name}</h3>
                  )}
                  <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
                    <button onClick={() => setMenu(m => (m === s.id ? null : s.id))} className="w-7 h-7 rounded-md flex items-center justify-center text-(--text-secondary) hover:text-white hover:bg-white/10 sm:opacity-0 group-hover:opacity-100 transition" aria-label="Story options">
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                    {menu === s.id && (
                      <div className="absolute right-0 top-8 z-20 w-36 rounded-lg bg-(--bg-primary) border border-white/10 shadow-xl p-1 text-sm">
                        <button onClick={() => { setRenaming({ id: s.id, name: s.name }); setMenu(null); }} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-white/8"><Pencil className="w-3.5 h-3.5" /> Rename</button>
                        <button onClick={() => { setDeleting(s); setMenu(null); }} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-white/8 text-(--error)"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-sm text-(--text-secondary) line-clamp-3 leading-relaxed flex-1">{preview}</p>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {lang && <span className="px-2 py-0.5 rounded-full bg-white/5 text-(--text-secondary)">{lang}</span>}
                  {s.level && <span className="px-2 py-0.5 rounded-full bg-white/5 text-(--text-secondary)">{s.level}</span>}
                  {s.word_count ? <span className="px-2 py-0.5 rounded-full bg-white/5 text-(--text-secondary)">{s.word_count} words</span> : null}
                  {s.deck_name && <span className="px-2 py-0.5 rounded-full bg-white/5 text-(--text-secondary) truncate max-w-40">{s.deck_name.split('::').pop()}</span>}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-(--text-secondary)">
                  <div className="flex-1 h-1 rounded-full bg-(--bg-primary)/60 overflow-hidden">{pct > 0 && <div className="h-full bg-(--accent)" style={{ width: `${pct}%` }} />}</div>
                  <span className="shrink-0">{pct > 0 ? `${Math.round(pct)}% read` : ago(s.created_at)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {deleting && createPortal(
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4" onClick={() => setDeleting(null)}>
          <div className="bg-(--bg-secondary) rounded-xl max-w-md w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete “{deleting.name}”?</h3>
            <p className="text-sm text-(--text-secondary)">The story is removed for good. Your cards aren’t affected.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleting(null)} className="btn btn-secondary">Cancel</button>
              <button onClick={remove} className="btn btn-error">Delete</button>
            </div>
          </div>
        </div>, document.body)}
    </div>
  );
}

// --- Reader ------------------------------------------------------------------------

interface Picked { text: string; vocab: string | null; rect: DOMRect; unit?: StoryUnit }
interface Piece { text: string; word?: boolean; vocab?: string; unit?: StoryUnit }

/** Grow a selection that starts or ends mid-word ("Marie p") to whole words ("Marie pense"). */
function snapToWords(text: string, context: string): string {
  const at = context.indexOf(text);
  if (at === -1) return text;
  const isLetter = (c: string | undefined) => !!c && /[\p{L}\p{M}\p{N}'’-]/u.test(c);
  let start = at, end = at + text.length;
  while (start > 0 && isLetter(context[start - 1]) && isLetter(context[start])) start--;
  while (end < context.length && isLetter(context[end]) && isLetter(context[end - 1])) end++;
  return context.slice(start, end).trim();
}

/** The AI writer the Story tab is set to (shared choice). */
const aiChoice = () => store.get<{ provider?: string; model?: string }>('story-ai', {});

function Reader({ id, onBack }: { id: number; onBack: () => void }) {
  const [story, setStory] = useState<SavedStory | null>(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<'s' | 'm' | 'l'>(() => store.get('reading-size', 'm'));
  const [showTr, setShowTr] = useState<boolean>(() => store.get('reading-translation', true));
  const [picked, setPicked] = useState<Picked | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ front: string; back: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState<{ error?: string } | null>(null);
  const [selection, setSelection] = useState<{ text: string; context: string; rect: DOMRect } | null>(null);
  const [explaining, setExplaining] = useState<{ text: string; context: string; rect: DOMRect } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    stories.get(id).then(r => setStory(r.story)).catch(() => setFailed(true));
    return () => { stopRef.current = true; window.speechSynthesis?.cancel(); };
  }, [id]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);

  const words = useMemo(() => story?.words ?? [], [story]);
  const vocab = useMemo<Vocab>(() => buildVocab(words, story?.word_forms ?? {}), [words, story]);
  const paras = useMemo(() => paragraphs(story?.content ?? ''), [story]);
  const hasTr = paras.some(p => p.translation);
  const lang = story ? storyLanguage(story) ?? story.annotations?.language ?? null : null;

  // Segmented paragraphs: the AI's reading units when the story has them, else our own tokenizer.
  const pieces = useMemo<Piece[][]>(() => {
    const ann = story?.annotations?.paragraphs;
    const byLower = new Map(words.map(w => [w.toLowerCase(), w]));
    return paras.map((p, i) => {
      const units = ann?.[i];
      if (!units?.length) return splitLine(p.text, vocab);
      return alignUnits(p.text, units).map(x => {
        if (!x.unit) return { text: x.text };
        const u = x.unit;
        const v = (u.v && byLower.get(u.v.toLowerCase())) || vocab.owner.get(fold(u.t)) || (u.l ? vocab.owner.get(fold(u.l)) : undefined);
        return { text: x.text, word: true, unit: u, vocab: v };
      });
    });
  }, [paras, story, vocab, words]);

  // How often each vocab word appears (for the side list).
  const freq = useMemo(() => {
    const m: Record<string, number> = {};
    for (const line of pieces) for (const x of line) if (x.vocab) m[x.vocab] = (m[x.vocab] ?? 0) + 1;
    return m;
  }, [pieces]);

  // Select a passage → "Explain" button.
  useEffect(() => {
    const onUp = () => setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (!sel || sel.rangeCount === 0 || text.length < 2 || !bodyRef.current?.contains(sel.anchorNode)) { setSelection(null); return; }
      const range = sel.getRangeAt(0);
      const para = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('[id^=para-]');
      const context = para?.querySelector('p')?.textContent ?? text;
      setSelection({ text: snapToWords(text, context), context, rect: range.getBoundingClientRect() });
    }, 10);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    return () => { document.removeEventListener('mouseup', onUp); document.removeEventListener('touchend', onUp); };
  }, []);

  const prepareLookups = async () => {
    if (!story) return;
    setAnnotating({});
    try {
      const { provider, model } = aiChoice();
      const r = await stories.annotate(story.id, provider || undefined, model || undefined);
      setStory(s => (s ? { ...s, annotations: r.annotations } : s));
      setAnnotating(null);
    } catch (e) {
      setAnnotating({ error: e instanceof Error ? e.message : 'Could not prepare lookups' });
    }
  };

  // Reading progress for the Study hub (scroll position, restored on open).
  const readSession = useSessionSaver('reading', story ? story.id : null, 1000);
  const storyName = story?.name ?? '';
  useEffect(() => {
    if (!story) return;
    let cancelled = false, tracking = false, finished = false;
    const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;
    studySessions.get<{ pct: number }>('reading', story.id).then(({ session }) => {
      const pct = session?.status === 'active' ? session.state?.pct : undefined;
      if (cancelled) return;
      if (!pct) { tracking = true; return; }
      requestAnimationFrame(() => { window.scrollTo({ top: pct * maxScroll(), behavior: 'smooth' }); setTimeout(() => { tracking = true; }, 700); });
    }).catch(() => { tracking = true; });
    const onScroll = () => {
      if (!tracking) return;
      const max = maxScroll();
      if (max < 200) return;
      const pct = window.scrollY / max;
      if (pct >= 0.95) { if (!finished) { finished = true; readSession.remove(); } return; }
      finished = false;
      if (pct < 0.03) return;
      readSession.save({ title: storyName, detail: `${Math.round(pct * 100)}% read`, progress_done: Math.round(pct * 100), progress_total: 100, state: { pct } });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { cancelled = true; window.removeEventListener('scroll', onScroll); };
  }, [story, storyName, readSession]);

  const readAloud = (from = 0) => {
    window.speechSynthesis?.cancel();
    if (speaking != null && from === 0) { stopRef.current = true; setSpeaking(null); return; }
    stopRef.current = false;
    const next = (i: number) => {
      if (stopRef.current || i >= paras.length) { setSpeaking(null); return; }
      setSpeaking(i);
      document.getElementById(`para-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!speak(paras[i].text, lang, () => next(i + 1))) setSpeaking(null);
    };
    next(from);
  };

  const jumpTo = (w: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-vocab="${CSS.escape(w)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(w);
    setTimeout(() => setFlash(null), 1600);
  };

  if (failed) return <div className="max-w-2xl mx-auto card text-center py-10 space-y-3"><p>This story couldn’t be found.</p><button onClick={onBack} className="btn btn-secondary">Back to stories</button></div>;
  if (!story) return <div className="max-w-2xl mx-auto space-y-3">{[50, 90, 80, 95, 70].map((w, i) => <div key={i} className="skeleton h-5 rounded" style={{ width: `${w}%` }} />)}</div>;

  const textSize = size === 's' ? 'text-base' : size === 'l' ? 'text-xl' : 'text-lg';
  const meaningOf = (w: string) => {
    const f = story.word_data?.[w]?.fields;
    if (!f) return '';
    const keys = (story.lookup_fields?.length ? story.lookup_fields : Object.keys(f)).filter(k => f[k] && clean(f[k]) && clean(f[k]) !== w);
    return keys.map(k => clean(f[k])).join(' · ');
  };

  return (
    <div className="max-w-6xl mx-auto pb-16">
      {/* Top bar */}
      <div className="sticky top-0 z-20 -mx-4 px-4 py-2.5 mb-5 bg-(--bg-primary)/90 backdrop-blur flex items-center gap-2">
        <button onClick={onBack} className="icon-btn shrink-0" title="All stories"><ArrowLeft className="w-4 h-4" /></button>
        <div className="flex-1" />
        <Segmented value={size} onChange={v => { setSize(v); store.set('reading-size', v); }}
          options={[{ value: 's', label: <span className="text-[11px]">A</span> }, { value: 'm', label: <span className="text-sm">A</span> }, { value: 'l', label: <span className="text-base">A</span> }]} />
        {hasTr && (
          <button onClick={() => { setShowTr(t => { store.set('reading-translation', !t); return !t; }); }} aria-pressed={showTr}
            className={`h-8 px-2.5 rounded-lg text-xs inline-flex items-center gap-1.5 transition-colors ${showTr ? 'bg-(--accent)/15 text-white' : 'bg-(--bg-tertiary) text-(--text-secondary) hover:text-white'}`}>
            <Languages className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Translation</span>
          </button>
        )}
        {'speechSynthesis' in window && (
          <button onClick={() => readAloud(0)}
            className={`h-8 px-2.5 rounded-lg text-xs inline-flex items-center gap-1.5 transition-colors ${speaking != null ? 'bg-(--accent) text-white' : 'bg-(--bg-tertiary) text-(--text-secondary) hover:text-white'}`}>
            {speaking != null ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />} <span className="hidden sm:inline">{speaking != null ? 'Stop' : 'Read aloud'}</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_17rem] gap-8 items-start">
        <article className="max-w-2xl w-full mx-auto lg:mx-0 lg:justify-self-end">
          <header className="mb-6 space-y-2">
            <h1 className="text-2xl sm:text-3xl font-bold leading-tight">{story.name}</h1>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-(--text-secondary)">
              {lang && <span className="px-2 py-0.5 rounded-full bg-white/5">{lang}</span>}
              {story.level && <span className="px-2 py-0.5 rounded-full bg-white/5">{story.level}</span>}
              {story.deck_name && <span className="px-2 py-0.5 rounded-full bg-white/5">{story.deck_name.split('::').pop()}</span>}
              <span className="px-2 py-0.5">{ago(story.created_at)}</span>
            </div>
          </header>
          {!story.annotations && (
            <div className="mb-6 rounded-xl bg-(--bg-secondary) px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
              <Sparkles className="w-4 h-4 text-(--accent) shrink-0" />
              <span className="flex-1 min-w-48 text-(--text-secondary)">
                {annotating?.error ? <span className="text-(--error)">{annotating.error}</span>
                  : 'This story was written before instant lookups. Prepare them once to get meanings in context for every word.'}
              </span>
              <button onClick={prepareLookups} disabled={!!annotating && !annotating.error}
                className="h-8 px-3 rounded-lg bg-(--accent) text-white text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-60">
                {annotating && !annotating.error ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Preparing…</> : 'Prepare lookups'}
              </button>
            </div>
          )}
          <div ref={bodyRef} className={`${textSize} leading-[1.85] space-y-5`}>
            {paras.map((p, i) => (
              <div key={i} id={`para-${i}`} className={`rounded-lg transition-colors -mx-3 px-3 py-1 ${speaking === i ? 'bg-(--accent)/10' : ''}`}>
                <p>
                  {pieces[i].map((x, j) => {
                    if (!x.word) return <span key={j}>{x.text}</span>;
                    const isVocab = !!x.vocab;
                    const pick = (el: HTMLElement) => setPicked({ text: x.text, vocab: x.vocab ?? null, rect: el.getBoundingClientRect(), unit: x.unit });
                    return (
                      <span key={j} role="button" tabIndex={0} data-vocab={x.vocab ?? undefined}
                        onClick={e => { if ((window.getSelection()?.toString().trim().length ?? 0) > 1) return; pick(e.currentTarget as HTMLElement); }}
                        onKeyDown={e => { if (e.key === 'Enter') pick(e.currentTarget as HTMLElement); }}
                        className={`cursor-pointer rounded-[4px] transition-colors ${isVocab
                          ? `text-(--accent) font-semibold decoration-(--accent)/40 underline decoration-dotted underline-offset-4 hover:bg-(--accent)/15 ${flash === x.vocab ? 'bg-(--accent)/30' : ''}`
                          : 'hover:bg-white/8'} ${picked?.text === x.text ? 'bg-white/10' : ''}`}>
                        {x.text}
                      </span>
                    );
                  })}
                </p>
                {p.translation && showTr && <p className="text-[0.85em] text-(--text-secondary) italic mt-1.5">{p.translation}</p>}
              </div>
            ))}
          </div>
          <div className="mt-10 pt-6 border-t border-white/8 flex flex-wrap gap-2">
            <Link to="/story" className="btn btn-secondary inline-flex items-center gap-2"><Wand2 className="w-4 h-4" /> Write another</Link>
            <button onClick={onBack} className="btn btn-secondary">All stories</button>
          </div>
        </article>

        {words.length > 0 && (
          <aside className="lg:sticky lg:top-20 card space-y-2 max-h-[calc(100vh-7rem)] overflow-y-auto" style={{ padding: '1rem' }}>
            <p className="text-xs font-semibold uppercase tracking-wider text-(--text-secondary) px-1">Words in this story · {words.length}</p>
            <div className="space-y-0.5">
              {words.map(w => (
                <button key={w} onClick={() => jumpTo(w)} disabled={!freq[w]}
                  className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent transition-colors">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-sm truncate">{w}</span>
                    <span className="text-[10px] text-(--text-secondary) shrink-0">{freq[w] ? `${freq[w]}×` : 'not used'}</span>
                  </span>
                  {meaningOf(w) && <span className="block text-xs text-(--text-secondary) truncate">{meaningOf(w)}</span>}
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>

      {picked && (
        <WordCard key={`${picked.text}-${Math.round(picked.rect.left)}-${Math.round(picked.rect.top)}`} picked={picked} story={story} lang={lang} onClose={() => setPicked(null)}
          onAdd={p => { setPicked(null); setAdding(p); }} />
      )}
      {selection && !explaining && createPortal(
        <button onMouseDown={e => e.preventDefault()} onClick={() => { setExplaining(selection); setSelection(null); }}
          className="fixed z-[140] -translate-x-1/2 -translate-y-full h-8 px-3 rounded-lg bg-(--accent) text-white text-xs font-semibold shadow-xl inline-flex items-center gap-1.5 section-pop"
          style={{ left: Math.max(60, Math.min(window.innerWidth - 60, selection.rect.left + selection.rect.width / 2)), top: Math.max(48, selection.rect.top - 8) }}>
          <Sparkles className="w-3.5 h-3.5" /> Explain
        </button>, document.body)}
      {explaining && (
        <ExplainCard key={explaining.text} passage={explaining.text} context={explaining.context} rect={explaining.rect} story={story} lang={lang}
          onClose={() => { setExplaining(null); window.getSelection()?.removeAllRanges(); }}
          onAdd={p => { setExplaining(null); setAdding(p); }} />
      )}
      {adding && <AddCardDialog prefill={adding} onClose={() => setAdding(null)} onAdded={d => { setAdding(null); setToast(`Added to ${d}`); }} />}
      {toast && createPortal(
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[300] rounded-lg bg-(--bg-secondary) border border-white/10 shadow-xl px-4 py-2.5 text-sm flex items-center gap-2">
          <Check className="w-4 h-4 text-green-400" /> {toast}
        </div>, document.body)}
    </div>
  );
}

// --- Popovers: word card + explain card ---------------------------------------------------

const dictCache = new Map<string, DictionaryResult>();

/** Position a popover next to `rect` (flipping above when needed) and close it on outside tap, Esc or scroll. */
function usePopover(ref: React.RefObject<HTMLDivElement | null>, rect: DOMRect, onClose: () => void, deps: unknown[]) {
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, rect.left + rect.width / 2 - w / 2));
    const above = rect.bottom + h + 16 > window.innerHeight && rect.top - h - 16 > 0;
    setPos({ left, top: above ? rect.top - h - 10 : Math.min(rect.bottom + 10, Math.max(12, window.innerHeight - h - 12)), above });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, ...deps]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('[role=button]')) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true, once: true });
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll); };
  }, [ref, onClose]);
  return pos;
}

const POS_LABEL: Record<string, string> = {
  noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb', pron: 'pronoun', prep: 'preposition', conj: 'conjunction',
  det: 'determiner', interj: 'interjection', num: 'number', expr: 'expression', name: 'name',
};

function WordCard({ picked, story, lang, onClose, onAdd }: {
  picked: Picked; story: SavedStory; lang: string | null; onClose: () => void; onAdd: (p: { front: string; back: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const unit = picked.unit;
  // Dictionary form to look up: the AI's lemma, else the vocab word, else the word itself
  // (lower-cased, so a sentence-initial "Hola" isn't read as a name).
  const base = unit?.l || (picked.vocab ? stripArticle(picked.vocab) || picked.vocab : picked.text.replace(/['’]$/, ''));
  const lookupWord = unit?.p === 'name' ? base : base.toLowerCase();
  const key = `${lookupWord}|${lang ?? ''}`;
  const [wantDict, setWantDict] = useState(!unit);
  const [dict, setDict] = useState<{ key: string; data: DictionaryResult | null } | null>(() => (dictCache.has(key) ? { key, data: dictCache.get(key)! } : null));
  const [ai, setAi] = useState<{ loading: boolean; text?: string; error?: string } | null>(null);
  const card: WordData | undefined = picked.vocab ? story.word_data?.[picked.vocab] : undefined;

  useEffect(() => {
    if (!wantDict || dictCache.has(key)) return;
    let cancelled = false;
    dictionary.lookup(lookupWord, lang ?? '').then(d => { dictCache.set(key, d); if (!cancelled) setDict({ key, data: d }); })
      .catch(() => { if (!cancelled) setDict({ key, data: null }); });
    return () => { cancelled = true; };
  }, [wantDict, key, lookupWord, lang]);

  const pos = usePopover(ref, picked.rect, onClose, [dict, ai, wantDict]);

  const data = dict?.key === key ? dict.data : dictCache.get(key);
  const lang0 = data?.wiktionary?.languages[0];
  const entry = lang0?.entries[0];
  const sense = entry?.senses.map(s => s.segments.map(x => x.t).join('')) ?? [];
  const jisho = data?.jisho?.[0];
  const fields = card ? Object.entries(card.fields)
    .filter(([k, v]) => clean(v) && (story.lookup_fields?.length ? story.lookup_fields.includes(k) : true) && clean(v) !== picked.vocab) : [];
  const sound = card ? soundOf(card.fields) : null;
  const meaning = unit?.g || (jisho ? jisho.senses[0]?.glosses.join('; ') : sense[0]) || (fields[0] ? clean(fields[0][1]) : ai?.text ?? '');

  const askAi = async () => {
    setAi({ loading: true });
    try {
      const r = await lookup.word(lookupWord, story.lookup_language || 'auto', undefined, undefined, undefined, true);
      setAi({ loading: false, text: [r.meaning, r.reading && `(${r.reading})`].filter(Boolean).join(' ') });
    } catch { setAi({ loading: false, error: 'AI lookup failed — check your API key in Story → AI settings.' }); }
  };

  const listen = async () => {
    if (sound) {
      try {
        const r = await media.get(sound);
        const ext = sound.split('.').pop()?.toLowerCase();
        new Audio(`data:${ext === 'ogg' ? 'audio/ogg' : ext === 'wav' ? 'audio/wav' : 'audio/mpeg'};base64,${r.data}`).play().catch(() => {});
        return;
      } catch { /* fall through to speech */ }
    }
    if (!unit && lang0?.audio[0]) { new Audio(lang0.audio[0]).play().catch(() => {}); return; }
    speak(picked.text, lang);
  };

  const dictBlock = data === undefined ? (
    <div className="space-y-1.5">{[80, 60].map(w => <div key={w} className="skeleton h-3.5 rounded" style={{ width: `${w}%` }} />)}</div>
  ) : jisho ? (
    <ol className="text-sm space-y-1 list-decimal list-inside marker:text-(--text-secondary)">
      {jisho.senses.slice(0, 3).map((s, i) => <li key={i}>{s.glosses.join('; ')}</li>)}
    </ol>
  ) : sense.length ? (
    <div className="space-y-1">
      <p className="text-[11px] text-(--text-secondary) flex flex-wrap gap-2">
        {lang0?.ipa[0] && <span className="font-mono">{lang0.ipa[0]}</span>}
        {entry && <span className="uppercase tracking-wide font-semibold">{entry.pos}</span>}
        {entry?.gender && <span className="px-1.5 rounded bg-white/5">{entry.gender}</span>}
      </p>
      <ol className="text-sm space-y-1 list-decimal list-inside marker:text-(--text-secondary)">
        {sense.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    </div>
  ) : (
    <div className="text-sm space-y-2">
      {!fields.length && !ai?.text && !unit && <p className="text-(--text-secondary)">No dictionary entry for this form.</p>}
      {unit && <p className="text-xs text-(--text-secondary)">No dictionary entry for “{lookupWord}”.</p>}
      {ai?.text && <p>{ai.text}</p>}
      {ai?.error && <p className="text-xs text-(--error)">{ai.error}</p>}
      {!ai?.text && !unit && (
        <button onClick={askAi} disabled={ai?.loading} className="text-xs inline-flex items-center gap-1.5 text-(--accent) hover:underline">
          {ai?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Ask AI what it means here
        </button>
      )}
    </div>
  );

  return createPortal(
    <div ref={ref} className="fixed z-[150] w-[min(22rem,calc(100vw-24px))] rounded-xl bg-(--bg-secondary) border border-white/10 shadow-2xl p-4 space-y-3 section-pop"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-lg font-bold leading-tight break-words">{picked.text}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-(--text-secondary)">
            {unit?.l && fold(unit.l) !== fold(picked.text) && <span>from <span className="text-white">{unit.l}</span></span>}
            {!unit && picked.vocab && fold(picked.vocab) !== fold(picked.text) && <span>from <span className="text-white">{picked.vocab}</span></span>}
            {unit?.p && <span className="text-(--accent) uppercase tracking-wide text-[10px] font-semibold">{POS_LABEL[unit.p] ?? unit.p}</span>}
            {!unit && entry && <span className="text-(--accent) uppercase tracking-wide text-[10px] font-semibold">{entry.pos}</span>}
            {!unit && lang0?.ipa[0] && <span className="font-mono">{lang0.ipa[0]}</span>}
            {picked.vocab && <span className="px-1.5 rounded bg-(--accent)/15 text-(--accent)">in your cards</span>}
          </div>
        </div>
        <button onClick={listen} className="icon-btn shrink-0" title="Listen"><Volume2 className="w-4 h-4" /></button>
        <button onClick={onClose} className="icon-btn shrink-0" title="Close"><X className="w-4 h-4" /></button>
      </div>

      {unit?.g && (
        <div className="space-y-1">
          <p className="text-base">{unit.g}</p>
          {unit.n && <p className="text-xs text-(--text-secondary) italic">{unit.n}</p>}
        </div>
      )}

      {fields.length > 0 && (
        <div className="rounded-lg bg-(--bg-tertiary)/60 p-2.5 space-y-1">
          {fields.slice(0, 4).map(([k, v]) => (
            <p key={k} className="text-sm"><span className="text-[10px] uppercase tracking-wider text-(--text-secondary) mr-1.5">{k}</span>{clean(v)}</p>
          ))}
        </div>
      )}

      {wantDict ? (unit ? <div className="pt-2 border-t border-white/8">{dictBlock}</div> : dictBlock) : (
        <button onClick={() => setWantDict(true)} className="text-xs text-(--text-secondary) hover:text-white inline-flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5" /> Dictionary entry for “{lookupWord}”
        </button>
      )}

      <div className="flex gap-2 pt-1">
        {!picked.vocab && (
          <button onClick={() => onAdd({ front: entry?.headword || unit?.l || lookupWord, back: meaning })}
            className="flex-1 h-8 rounded-lg bg-(--accent) text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 hover:brightness-110">
            <Plus className="w-3.5 h-3.5" /> Add as card
          </button>
        )}
        <Link to={`/search?q=${encodeURIComponent(lookupWord)}`} className="flex-1 h-8 rounded-lg bg-(--bg-tertiary) text-xs text-(--text-secondary) hover:text-white inline-flex items-center justify-center gap-1.5">
          <SearchIcon className="w-3.5 h-3.5" /> Full entry
        </Link>
      </div>
      <style>{`@keyframes pop { from { opacity: 0; transform: translateY(${pos?.above ? 4 : -4}px) scale(.98) } to { opacity: 1; transform: none } } .section-pop { animation: pop .16s ease-out }`}</style>
    </div>,
    document.body,
  );
}

/** Explanation of a selected passage: translation, breakdown, grammar. */
function ExplainCard({ passage, context, rect, story, lang, onClose, onAdd }: {
  passage: string; context: string; rect: DOMRect; story: SavedStory; lang: string | null;
  onClose: () => void; onAdd: (p: { front: string; back: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [res, setRes] = useState<{ text?: string; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const { provider, model } = aiChoice();
    stories.explain({
      passage, context, language: lang, level: story.level ?? null,
      gloss_language: story.annotations?.gloss_language || (story.lookup_language && story.lookup_language !== 'auto' ? story.lookup_language : 'English'),
      provider: provider || undefined, model: model || undefined,
    }).then(r => { if (!cancelled) setRes({ text: r.explanation }); })
      .catch(e => { if (!cancelled) setRes({ error: e instanceof Error ? e.message : 'Could not explain this passage' }); });
    return () => { cancelled = true; };
  }, [passage, context, lang, story]);
  const pos = usePopover(ref, rect, onClose, [res]);
  const translation = res?.text ? /\*\*Translation\*\*\s*[—–:-]*\s*([^\n]+)/.exec(res.text)?.[1]?.trim() : undefined;

  return createPortal(
    <div ref={ref} className="fixed z-[150] w-[min(28rem,calc(100vw-24px))] max-h-[min(70vh,34rem)] overflow-y-auto rounded-xl bg-(--bg-secondary) border border-white/10 shadow-2xl p-4 space-y-3 section-pop"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
      <div className="flex items-start gap-2">
        <p className="flex-1 min-w-0 font-semibold leading-snug">“{passage}”</p>
        <button onClick={() => speak(passage, lang)} className="icon-btn shrink-0" title="Listen"><Volume2 className="w-4 h-4" /></button>
        <button onClick={onClose} className="icon-btn shrink-0" title="Close"><X className="w-4 h-4" /></button>
      </div>
      {!res ? (
        <div className="space-y-2">
          <p className="text-xs text-(--text-secondary) inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Explaining…</p>
          {[90, 70, 80].map(w => <div key={w} className="skeleton h-3.5 rounded" style={{ width: `${w}%` }} />)}
        </div>
      ) : res.error ? (
        <p className="text-sm text-(--error)">{res.error}</p>
      ) : (
        <div className="text-sm leading-relaxed space-y-2 [&_strong]:text-white [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_em]:text-(--accent) [&_em]:not-italic">
          <ReactMarkdown>{res.text ?? ''}</ReactMarkdown>
        </div>
      )}
      {translation && (
        <button onClick={() => onAdd({ front: passage, back: translation })}
          className="w-full h-8 rounded-lg bg-(--accent) text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 hover:brightness-110">
          <Plus className="w-3.5 h-3.5" /> Save this phrase as a card
        </button>
      )}
    </div>,
    document.body,
  );
}
