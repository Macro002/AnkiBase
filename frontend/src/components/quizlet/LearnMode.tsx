import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { Check, X, Settings, RotateCcw, Lightbulb, ArrowRight, Loader2 } from 'lucide-react';
import CramIcon from '../../assets/icons/brand-cram.svg?react';
import MemorizeIcon from '../../assets/icons/brand-memorize.svg?react';
import LearnIcon from '../../assets/icons/brand-learn.svg?react';
import WriteIcon from '../../assets/icons/brand-write.svg?react';
import { quizlet, studySessions, type QuizletCard } from '../../api';
import { useSessionSaver } from '../../hooks/useSessionSaver';
import * as L from './learnEngine';
import type { LearnSettings, LearnState, QType, Level } from './learnEngine';
import {
  answerOf, gradeAnswer, mcOptions, pickDistractors, promptOf, resolveSide, sample, sizeClass, stripHtml, usesLatinAccents,
  type GradeResult, type Side,
} from './shared';
import { AccentBar, Html, Segmented, SettingRow, SidePanel, Toggle } from './ui';

interface Question {
  id: number;
  qtype: QType;
  side: Side;
  options: QuizletCard[];
  /** True/false: the answer shown next to the prompt, and whether it is the right one. */
  tfShown?: QuizletCard;
  tfTrue?: boolean;
  key: string;
}

interface Pending {
  correct: boolean;
  grade?: GradeResult;
  selected?: number | 'true' | 'false';
  typed?: string;
  dontKnow?: boolean;
  /** Feedback line, picked once so it doesn't change on re-render. */
  msg: string;
}

const PRAISE = ['Nice work!', 'You’re on a roll!', 'Great job!', 'Nailed it!', 'Correct!', 'Keep it up!'];
const ENCOURAGE = ['Not quite — you’re still learning!', 'No worries, learning is a process.', 'Almost! This one will come back.'];

function makeQuestion(state: LearnState, byId: Map<number, QuizletCard>, pool: QuizletCard[]): Question | null {
  const id = L.currentId(state);
  if (id == null) return null;
  const card = byId.get(id);
  if (!card) return null;
  const qtype = L.questionType(state, id, pool.length);
  const side = resolveSide(state.settings.answerWith);
  const q: Question = { id, qtype, side, options: [], key: `${state.round.number}-${state.asked}` };
  if (qtype === 'mc') q.options = mcOptions(card, pool, side, Math.min(4, pool.length));
  if (qtype === 'tf') {
    const isTrue = Math.random() < 0.5;
    const other = pickDistractors(card, pool, side, 1)[0];
    q.tfTrue = isTrue || !other;
    q.tfShown = q.tfTrue ? card : other;
  }
  return q;
}

export interface LearnModeProps {
  deckId: number;
  title: string;
  cards: QuizletCard[];
  favorites: Set<number>;
  onReviewed: () => void;
  onLevels: (levels: Map<number, Level>) => void;
  onOpenMode: (mode: 'flashcards' | 'test') => void;
  /** Write mode (typed answers only) — chosen from the mode grid or the options toggle. */
  write: boolean;
  onWriteChange: (write: boolean) => void;
}

export function LearnMode({ deckId, title, cards, favorites, onReviewed, onLevels, onOpenMode, write, onWriteChange }: LearnModeProps) {
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<LearnState | null>(null);
  const [draftSettings, setDraftSettings] = useState<LearnSettings>(L.DEFAULT_SETTINGS);
  const [rawQuestion, setQuestion] = useState<Question | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [typed, setTyped] = useState('');
  const [retype, setRetype] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const byId = useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);
  const cardIds = useMemo(() => cards.map(c => c.id), [cards]);
  const showAccents = useMemo(() => usesLatinAccents(cards.flatMap(c => [c.front, c.back])), [cards]);

  // --- persistence (one resumable session per deck, listed in the Study hub) ---
  const session = useSessionSaver('quizlet-learn', deckId, 600);

  const scheduleSave = useCallback((s: LearnState) => {
    const c = L.counts(s);
    session.save({
      title,
      // The Study hub reads the "Write" prefix to reopen the right tile.
      detail: s.status === 'complete' ? 'All terms mastered'
        : `${s.settings.write ? 'Write' : s.settings.goal === 'cram' ? 'Cram' : 'Memorize'} · round ${s.round.number} · ${c.mastered}/${c.total} mastered`,
      // Overall progress, so Familiar terms already move the bar.
      progress_done: Math.round(L.progress(s) * 100),
      progress_total: 100,
      status: s.status === 'complete' ? 'completed' : 'active',
      state: s,
    }, s.status !== 'active'); // round boundaries are worth saving right away
  }, [session, title]);

  useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current); }, []);

  /** Single entry point for state changes: rebuild the question, reset inputs, save. */
  const commit = useCallback((next: LearnState | null, save = true) => {
    // The selected tile (Learn or Write) decides write mode, for saved sessions too.
    const s = next && { ...next, settings: { ...next.settings, write } };
    setState(s);
    setPending(null);
    setTyped('');
    setRetype(null);
    setFlipped(false);
    // Wrong answers are drawn from the whole set, even when studying starred terms only.
    setQuestion(s ? makeQuestion(s, byId, cards) : null);
    if (s) {
      onLevels(L.levels(s));
      if (save) scheduleSave(s);
    }
  }, [byId, cards, onLevels, scheduleSave, write]);

  useEffect(() => {
    let cancelled = false;
    studySessions.get<LearnState>('quizlet-learn', deckId).then(({ session: sess }) => {
      if (cancelled) return;
      const saved = sess?.state;
      if (saved && saved.version === 1 && saved.order?.length) {
        const s = L.reconcile(saved, cardIds, favorites);
        setDraftSettings(s.settings);
        commit(s, false);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
    // Load once per deck; later card edits are reconciled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const start = (settings: LearnSettings) => {
    setDraftSettings(settings);
    commit(L.createState(cardIds, settings, favorites));
  };

  const restart = () => {
    setConfirmRestart(false);
    setShowSettings(false);
    session.remove();
    setState(null);
    setQuestion(null);
    setPending(null);
    onLevels(new Map());
  };

  const updateSettings = (patch: Partial<LearnSettings>) => {
    const next = { ...draftSettings, ...patch, types: { ...draftSettings.types, ...(patch.types ?? {}) } };
    setDraftSettings(next);
    if (!state) return;
    const s = L.reconcile({ ...state, settings: next }, cardIds, favorites);
    // Keep the current question unless what it asks no longer makes sense.
    const typeChanged = question && !next.types[question.qtype];
    const sideChanged = patch.answerWith !== undefined;
    if (typeChanged || sideChanged || patch.starredOnly !== undefined || L.currentId(s) !== question?.id) commit(s);
    else { setState(s); scheduleSave(s); }
  };

  // Switching to Write mid-question turns the current question into a typed one.
  const question = useMemo(() => (rawQuestion && write && rawQuestion.qtype !== 'written' && !pending
    ? { ...rawQuestion, qtype: 'written' as const }
    : rawQuestion), [rawQuestion, write, pending]);

  // --- answering -----------------------------------------------------------
  const card = question ? byId.get(question.id) ?? null : null;
  const correctHtml = card && question ? answerOf(card, question.side) : '';
  const promptHtml = card && question ? promptOf(card, question.side) : '';

  const finish = useCallback((correct: boolean) => {
    if (!state || !question) return;
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    quizlet.review(deckId, question.id, correct ? 2 : 1).then(onReviewed).catch(() => {});
    commit(L.answer(state, correct, question.qtype));
  }, [state, question, deckId, onReviewed, commit]);

  const reveal = (p: Omit<Pending, 'msg'>) => {
    setPending({ ...p, msg: sample(p.correct ? PRAISE : ENCOURAGE) });
    if (p.correct && (question?.qtype === 'mc' || question?.qtype === 'tf') && !p.grade?.note) {
      autoTimer.current = setTimeout(() => finish(true), 900);
    }
  };

  const submitWritten = () => {
    if (!question || pending) return;
    if (!typed.trim()) return;
    const grade = gradeAnswer(typed, correctHtml, draftSettings.grading, draftSettings.anyPart);
    reveal({ correct: grade.correct, grade, typed });
  };

  const dontKnow = () => {
    if (!question || pending) return;
    reveal({ correct: false, dontKnow: true, typed: '' });
  };

  const continueFromFeedback = () => {
    if (!pending) return;
    if (!pending.correct && question?.qtype === 'written' && draftSettings.retypeWrong && retype === null) {
      setRetype('');
      return;
    }
    finish(pending.correct);
  };

  const override = () => {
    if (!pending || pending.correct) return;
    finish(true);
  };

  const retypeOk = retype !== null && gradeAnswer(retype, correctHtml, 'moderate', false).correct;

  // --- keyboard ------------------------------------------------------------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (showSettings || confirmRestart) return;
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    if (state?.status === 'summary' && e.key === 'Enter') { e.preventDefault(); commit(L.continueAfterSummary(state)); return; }
    if (!question || state?.status !== 'active') return;
    if (pending) {
      if (retype !== null) return;
      if (e.key === 'Enter' || (!typing && e.key === ' ')) { e.preventDefault(); continueFromFeedback(); }
      return;
    }
    if (typing) return;
    if (question.qtype === 'mc') {
      const n = Number(e.key);
      if (n >= 1 && n <= question.options.length) { e.preventDefault(); const opt = question.options[n - 1]; reveal({ correct: opt.id === question.id, selected: opt.id }); }
    } else if (question.qtype === 'tf') {
      if (e.key === '1' || e.key.toLowerCase() === 't') reveal({ correct: question.tfTrue === true, selected: 'true' });
      if (e.key === '2' || e.key.toLowerCase() === 'f') reveal({ correct: question.tfTrue === false, selected: 'false' });
    } else if (question.qtype === 'flashcard') {
      if (e.key === ' ') { e.preventDefault(); setFlipped(f => !f); }
      if (flipped && e.key === '1') finish(false);
      if (flipped && e.key === '2') finish(true);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  useEffect(() => {
    if (question?.qtype === 'written' && !pending) inputRef.current?.focus();
  }, [question?.key, question?.qtype, pending]);

  // --- render --------------------------------------------------------------
  if (loading) {
    return <div className="card flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-(--text-secondary)" /></div>;
  }

  if (cards.length === 0) {
    return <div className="card text-center py-12 text-(--text-secondary)">This set has no terms yet.</div>;
  }

  const settingsPanel = showSettings && (
    <LearnSettingsPanel settings={draftSettings} write={write} onWriteChange={onWriteChange} hasStarred={favorites.size > 0} canPick={cards.length >= 2}
      onChange={updateSettings} onClose={() => setShowSettings(false)} onRestart={() => setConfirmRestart(true)} active={!!state} />
  );
  const restartDialog = confirmRestart && (
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4" onClick={() => setConfirmRestart(false)}>
      <div className="bg-(--bg-secondary) rounded-xl max-w-md w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold">Restart Learn?</h3>
        <p className="text-sm text-(--text-secondary)">This clears your Learn progress for this set. Every term goes back to “Not studied”.</p>
        <div className="flex gap-2 justify-end">
          <button onClick={() => setConfirmRestart(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={restart} className="btn btn-primary">Restart</button>
        </div>
      </div>
    </div>
  );

  // Goal picker — shown when there's no saved session.
  if (!state) {
    return (
      <>
        <div className="card relative flex flex-col space-y-5 overflow-hidden" style={{ padding: '1.5rem' }}>
          {write
            ? <WriteIcon className="absolute top-4 right-4 w-7 h-7 opacity-20 pointer-events-none" style={{ color: 'var(--accent)' }} />
            : <LearnIcon className="absolute top-4 right-4 w-7 h-7 opacity-20 pointer-events-none" style={{ color: 'var(--accent)' }} />}
          <div className="text-center">
            <h2 className="text-xl font-bold mb-1">{write ? 'Choose a goal for Write' : 'Choose a goal for this session'}</h2>
            <p className="text-sm text-(--text-secondary)">This will shape how your session works. Your progress is saved as you go.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              { g: 'cram' as const, title: 'Cram for a test', Icon: CramIcon,
                desc: write ? 'Type each term correctly once. Fast review of the whole set.' : 'Get each term right once. Fast review of the whole set.' },
              { g: 'memorize' as const, title: 'Memorize it all', Icon: MemorizeIcon,
                desc: write ? 'Type each term correctly twice, in separate rounds.' : 'Recognize it, then recall it. Each term needs two correct answers in separate rounds.' },
            ]).map(({ g, title, desc, Icon }) => (
              <button key={g} onClick={() => start({ ...draftSettings, goal: g })}
                className="group rounded-xl p-4 bg-(--bg-tertiary) hover:bg-(--accent)/10 transition-colors text-left flex flex-col">
                <div className="flex-1">
                  <p className="font-bold text-sm mb-1.5 group-hover:text-(--accent) transition-colors">{title}</p>
                  <p className="text-xs text-(--text-secondary) leading-relaxed">{desc}</p>
                </div>
                <Icon className="w-8 h-8 mt-3 self-end" style={{ color: 'rgba(var(--accent-rgb), 0.5)' }} />
              </button>
            ))}
          </div>
          <button onClick={() => setShowSettings(true)} className="text-sm text-(--text-secondary) hover-accent self-center flex items-center gap-1.5">
            <Settings className="w-4 h-4" /> Options
          </button>
        </div>
        {settingsPanel}
      </>
    );
  }

  const c = L.counts(state);
  const pct = L.progress(state);
  const rp = L.roundProgress(state);

  const progressBar = (
    <div className="flex items-center gap-3">
      <div className="flex-1 space-y-1.5">
        <div className="h-2.5 bg-(--bg-tertiary) rounded-full overflow-hidden flex">
          <div className="h-full bg-(--accent) transition-all duration-500" style={{ width: `${(c.mastered / c.total) * 100}%` }} />
          {state.settings.goal === 'memorize' && (
            <div className="h-full transition-all duration-500" style={{ width: `${(c.familiar / c.total) * 100}%`, background: 'rgba(var(--accent-rgb), 0.4)' }} />
          )}
        </div>
        <div className="flex justify-between text-xs text-(--text-secondary) tabular-nums">
          <span>{state.status === 'active' ? `Round ${state.round.number} · ${rp.done}/${rp.total}` : `Round ${state.round.number}`}</span>
          <span>{c.mastered}/{c.total} mastered · {Math.round(pct * 100)}%</span>
        </div>
      </div>
      <button onClick={() => setShowSettings(true)} className="icon-btn shrink-0" title="Learn options"><Settings className="w-4 h-4" /></button>
    </div>
  );

  if (state.status === 'summary') {
    return (
      <>
        <div className="card space-y-5">
          <div>
            <p className="text-xs text-(--text-secondary) uppercase tracking-wider font-semibold mb-1">Round {state.round.number} complete</p>
            <h2 className="text-2xl font-bold">{roundHeadline(state)}</h2>
          </div>
          <LevelLegend counts={c} goal={state.settings.goal} />
          <div>
            <p className="text-xs font-semibold text-(--text-secondary) uppercase tracking-wider mb-2">Terms studied this round</p>
            <div className="space-y-1.5">
              {state.round.ids.map(id => {
                const cd = byId.get(id);
                if (!cd) return null;
                const lvl = state.terms[id].level;
                const missed = (state.round.results[id] ?? []).includes(false);
                return (
                  <div key={id} className="flex gap-3 rounded-lg px-3 py-2 text-sm bg-(--bg-tertiary) items-center">
                    <Html html={cd.front} className="flex-1 font-medium leading-snug min-w-0" />
                    <div className="w-px self-stretch bg-white/10 shrink-0" />
                    <Html html={cd.back} className="flex-1 text-(--text-secondary) leading-snug min-w-0" />
                    <span className={`text-[11px] font-semibold shrink-0 w-24 text-right ${lvl === 3 ? 'text-green-400' : missed ? 'text-orange-400' : 'text-(--accent)'}`}>
                      {lvl === 3 ? 'Mastered' : lvl === 2 ? (missed ? 'Got it after a miss' : '1 more to go') : 'Still learning'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <button onClick={() => commit(L.continueAfterSummary(state))} className="btn btn-primary w-full flex items-center justify-center gap-2">
            Continue to round {state.round.number + 1} <ArrowRight className="w-4 h-4" />
          </button>
          <p className="text-xs text-center text-(--text-secondary)">Press Enter to continue</p>
        </div>
        {settingsPanel}{restartDialog}
      </>
    );
  }

  if (state.status === 'complete') {
    return (
      <>
        <LearnComplete state={state} byId={byId}
          onAgain={() => start(draftSettings)} onTest={() => onOpenMode('test')} onFlashcards={() => onOpenMode('flashcards')} />
        {settingsPanel}{restartDialog}
      </>
    );
  }

  if (!question || !card) return null;

  const promptLabel = question.side === 'definition' ? 'Term' : 'Definition';
  const answerLabel = question.side === 'definition' ? 'definition' : 'term';
  const showImage = !!card.image && !brokenImages.has(card.id);
  const promptText = stripHtml(promptHtml);

  return (
    <>
      <div className="space-y-4">
        {progressBar}

        {/* Prompt */}
        <div className="card flex flex-col" style={{ minHeight: 'clamp(11rem, 40vw, 18rem)' }}>
          <div className="flex items-center justify-between shrink-0">
            <span className="text-xs text-(--text-secondary) uppercase tracking-wide">{promptLabel}</span>
            {question.qtype === 'written' && !pending && (
              <button onClick={dontKnow} className="text-xs text-(--text-secondary) hover-accent flex items-center gap-1">
                <Lightbulb className="w-3.5 h-3.5" /> Don’t know?
              </button>
            )}
          </div>
          <div className={`flex-1 flex items-center gap-4 py-4 ${showImage ? '' : 'justify-center text-center'}`}>
            <Html html={promptHtml} className={`${sizeClass(promptText)} font-medium leading-snug flex-1 min-w-0 ${showImage ? '' : 'text-center'}`} />
            {showImage && (
              <img src={card.image!} alt="" className="w-32 h-32 sm:w-40 sm:h-40 object-contain rounded-lg shrink-0"
                onError={() => setBrokenImages(s => new Set(s).add(card.id))} />
            )}
          </div>
          {question.qtype === 'tf' && question.tfShown && (
            <div className="border-t border-white/8 pt-4 mt-2">
              <span className="text-xs text-(--text-secondary) uppercase tracking-wide">{question.side === 'definition' ? 'Definition' : 'Term'}</span>
              <Html html={answerOf(question.tfShown, question.side)} className="text-xl font-medium leading-snug mt-2" />
            </div>
          )}
        </div>

        {/* Answer area */}
        {question.qtype === 'mc' && (
          <div className="space-y-3">
            <p className="text-sm text-(--text-secondary) font-medium">
              {pending ? pending.msg : `Choose the matching ${answerLabel}`}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {question.options.map((opt, i) => {
                const isRight = opt.id === question.id;
                const isSel = pending?.selected === opt.id;
                const cls = pending
                  ? isRight ? 'bg-green-500/15 ring-1 ring-green-500/60' : isSel ? 'bg-red-500/15 ring-1 ring-red-500/60' : 'bg-(--bg-secondary) opacity-40'
                  : 'bg-(--bg-secondary) hover:bg-white/8 cursor-pointer';
                return (
                  <button key={opt.id} disabled={!!pending}
                    onClick={() => reveal({ correct: isRight, selected: opt.id })}
                    className={`rounded-xl text-left p-4 w-full text-sm font-medium transition-all flex items-start gap-3 ${cls}`}>
                    <span className="shrink-0 w-6 h-6 rounded-md bg-(--bg-tertiary) flex items-center justify-center text-xs font-bold text-(--text-secondary)">
                      {pending && isRight ? <Check className="w-3.5 h-3.5 text-green-400" /> : pending && isSel ? <X className="w-3.5 h-3.5 text-red-400" /> : i + 1}
                    </span>
                    <Html html={answerOf(opt, question.side)} className="min-w-0" />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {question.qtype === 'tf' && (
          <div className="space-y-3">
            <p className="text-sm text-(--text-secondary) font-medium">
              {pending ? pending.msg : 'Is this pair a match?'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(['true', 'false'] as const).map((v, i) => {
                const isRight = (v === 'true') === question.tfTrue;
                const isSel = pending?.selected === v;
                const cls = pending
                  ? isRight ? 'bg-green-500/15 ring-1 ring-green-500/60' : isSel ? 'bg-red-500/15 ring-1 ring-red-500/60' : 'bg-(--bg-secondary) opacity-40'
                  : 'bg-(--bg-secondary) hover:bg-white/8 cursor-pointer';
                return (
                  <button key={v} disabled={!!pending} onClick={() => reveal({ correct: isRight, selected: v })}
                    className={`rounded-xl p-4 text-sm font-semibold transition-all flex items-center justify-center gap-2 ${cls}`}>
                    <span className="w-6 h-6 rounded-md bg-(--bg-tertiary) flex items-center justify-center text-xs font-bold text-(--text-secondary)">{i + 1}</span>
                    {v === 'true' ? 'True' : 'False'}
                  </button>
                );
              })}
            </div>
            {pending && !pending.correct && question.tfTrue === false && (
              <div className="rounded-lg p-3 text-sm bg-(--bg-secondary)">
                <span className="text-(--text-secondary)">Correct match: </span>
                <Html html={correctHtml} className="inline font-semibold" />
              </div>
            )}
          </div>
        )}

        {question.qtype === 'written' && (
          <div className="space-y-3">
            {!pending && (
              <>
                <form onSubmit={e => { e.preventDefault(); submitWritten(); }} className="flex gap-2">
                  <input ref={inputRef} type="text" value={typed} onChange={e => setTyped(e.target.value)}
                    placeholder={`Type the ${answerLabel}`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                    className="input flex-1 text-base py-3" />
                  <button type="submit" disabled={!typed.trim()} className="btn btn-primary px-5 disabled:opacity-40">Answer</button>
                </form>
                {showAccents && <AccentBar inputRef={inputRef} onInsert={setTyped} />}
              </>
            )}
            {pending && <WrittenFeedback pending={pending} correctHtml={correctHtml} onOverride={override} />}
            {pending && retype !== null && (
              <form onSubmit={e => { e.preventDefault(); if (retypeOk) finish(false); }} className="space-y-2">
                <p className="text-sm text-(--text-secondary)">Type the correct answer to continue</p>
                <div className="flex gap-2">
                  <input autoFocus type="text" value={retype} onChange={e => setRetype(e.target.value)}
                    autoComplete="off" spellCheck={false}
                    className={`input flex-1 text-base py-3 ${retypeOk ? 'border-green-500' : ''}`} />
                  <button type="submit" disabled={!retypeOk} className="btn btn-primary px-5 disabled:opacity-40">Continue</button>
                </div>
              </form>
            )}
          </div>
        )}

        {question.qtype === 'flashcard' && (
          <div className="space-y-3">
            <button onClick={() => setFlipped(f => !f)}
              className="card w-full flex flex-col items-center justify-center text-center p-6 select-none hover:bg-white/5 transition-colors"
              style={{ minHeight: 'clamp(7rem, 25vw, 11rem)' }}>
              {flipped
                ? <Html html={correctHtml} className={`${sizeClass(stripHtml(correctHtml))} font-medium leading-snug`} />
                : <span className="text-sm text-(--text-secondary)">Think of the {answerLabel}, then tap (Space) to reveal</span>}
            </button>
            {flipped && (
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => finish(false)}
                  className="py-3 rounded-lg bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 font-medium text-sm flex items-center justify-center gap-2 transition-colors">
                  <X className="w-4 h-4" /> Still learning <kbd className="text-[10px] opacity-60">1</kbd>
                </button>
                <button onClick={() => finish(true)} className="btn btn-primary flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" /> Got it <kbd className="text-[10px] opacity-60">2</kbd>
                </button>
              </div>
            )}
          </div>
        )}

        {pending && retype === null && (
          <button onClick={continueFromFeedback} className="btn btn-secondary w-full flex items-center justify-center gap-2">
            Continue <span className="text-xs opacity-60">(Enter)</span>
          </button>
        )}
      </div>
      {settingsPanel}{restartDialog}
    </>
  );
}

function roundHeadline(state: LearnState): string {
  const { ids, results } = state.round;
  const firstTry = ids.filter(id => results[id]?.[0] === true).length;
  if (firstTry === ids.length) return 'Perfect round — every answer right first time!';
  if (firstTry / ids.length >= 0.7) return `${firstTry}/${ids.length} right first time. You’re crushing it!`;
  return `${firstTry}/${ids.length} right first time. Missed terms will come back.`;
}

function WrittenFeedback({ pending, correctHtml, onOverride }: { pending: Pending; correctHtml: string; onOverride: () => void }) {
  if (pending.correct) {
    const note = pending.grade?.note;
    return (
      <div className="rounded-lg p-4 text-sm bg-green-500/10 space-y-1">
        <div className="flex items-center gap-2 text-green-400 font-semibold"><Check className="w-4 h-4" /> {pending.msg}</div>
        {note && (
          <p className="text-white/80">
            {note === 'accents' ? 'Watch the accents: ' : note === 'typo' ? 'Small typo — the spelling is: ' : 'Full answer: '}
            <Html html={correctHtml} className="inline font-semibold" />
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-lg p-4 text-sm bg-red-500/10 space-y-3">
      <div className="flex items-center gap-2 text-red-400 font-semibold">
        <X className="w-4 h-4" /> {pending.dontKnow ? 'Let’s look at the answer' : pending.grade?.accentOnly ? 'So close — only the accents are off' : pending.msg}
      </div>
      {!pending.dontKnow && (
        <div>
          <p className="text-xs text-(--text-secondary) mb-0.5">Your answer</p>
          <p className="text-white/80 line-through decoration-red-400/60">{pending.typed}</p>
        </div>
      )}
      <div>
        <p className="text-xs text-(--text-secondary) mb-0.5">Correct answer</p>
        <Html html={correctHtml} className="font-semibold text-base" />
      </div>
      {!pending.dontKnow && (
        <button onClick={onOverride} className="text-xs text-(--accent) hover-underline">Override: I was correct</button>
      )}
    </div>
  );
}

function LevelLegend({ counts: c, goal }: { counts: L.Counts; goal: L.Goal }) {
  const rows = [
    { label: 'Mastered', n: c.mastered, color: 'bg-green-500' },
    ...(goal === 'memorize' ? [{ label: 'Familiar', n: c.familiar, color: 'bg-(--accent)' }] : []),
    { label: 'Still learning', n: c.learning, color: 'bg-orange-500' },
    { label: 'Not studied', n: c.notStudied, color: 'bg-(--bg-tertiary)' },
  ];
  return (
    <div className="space-y-2">
      <div className="h-2.5 rounded-full overflow-hidden flex bg-(--bg-tertiary)">
        {rows.map(r => <div key={r.label} className={`h-full ${r.color} transition-all duration-500`} style={{ width: `${(r.n / Math.max(c.total, 1)) * 100}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {rows.map(r => (
          <span key={r.label} className="flex items-center gap-1.5 text-(--text-secondary)">
            <span className={`w-2.5 h-2.5 rounded-sm ${r.color}`} />{r.label} <span className="font-semibold text-white">{r.n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function LearnComplete({ state, byId, onAgain, onTest, onFlashcards }: {
  state: LearnState; byId: Map<number, QuizletCard>; onAgain: () => void; onTest: () => void; onFlashcards: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const fire = confetti.create(canvasRef.current, { resize: true });
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const colors = [accent, '#ffffff', '#4ade80'];
    fire({ particleCount: 90, angle: 65, spread: 55, origin: { x: 0, y: 1 }, colors });
    fire({ particleCount: 90, angle: 115, spread: 55, origin: { x: 1, y: 1 }, colors });
    return () => fire.reset();
  }, []);

  const total = state.order.length;
  const firstTry = state.order.filter(id => state.terms[id].firstTry === true).length;
  const firstPct = total ? Math.round((firstTry / total) * 100) : 0;
  const minutes = Math.max(1, Math.round(((state.finishedAt ?? state.startedAt) - state.startedAt) / 60000));
  const struggled = state.order
    .filter(id => state.terms[id].wrong > 0)
    .sort((a, b) => state.terms[b].wrong - state.terms[a].wrong)
    .slice(0, 8);

  return (
    <div className="card relative overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <div className="relative space-y-6">
        <div>
          <h2 className="text-2xl font-bold">You’ve mastered all {total} {total === 1 ? 'term' : 'terms'}!</h2>
          <p className="text-sm text-(--text-secondary) mt-1">
            {state.settings.goal === 'memorize' ? 'Each one recognized and recalled.' : 'Every term answered correctly.'} Come back later to keep them fresh.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { v: `${firstPct}%`, l: 'right first time' },
            { v: state.asked, l: 'questions answered' },
            { v: minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`, l: 'time studying' },
          ].map(s => (
            <div key={s.l} className="rounded-xl bg-(--bg-tertiary) p-3 text-center">
              <p className="text-xl font-bold tabular-nums">{s.v}</p>
              <p className="text-[11px] text-(--text-secondary) mt-0.5">{s.l}</p>
            </div>
          ))}
        </div>
        {struggled.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-(--text-secondary) uppercase tracking-wider mb-2">Terms you missed most</p>
            <div className="space-y-1.5">
              {struggled.map(id => {
                const cd = byId.get(id);
                if (!cd) return null;
                return (
                  <div key={id} className="flex gap-3 rounded-lg px-3 py-2 text-sm bg-(--bg-tertiary) items-center">
                    <Html html={cd.front} className="flex-1 font-medium min-w-0" />
                    <div className="w-px self-stretch bg-white/10" />
                    <Html html={cd.back} className="flex-1 text-(--text-secondary) min-w-0" />
                    <span className="text-[11px] text-orange-400 font-semibold shrink-0">{state.terms[id].wrong}× missed</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button onClick={onTest} className="btn btn-primary">Take a practice test</button>
          <button onClick={onAgain} className="btn btn-secondary flex items-center justify-center gap-2"><RotateCcw className="w-4 h-4" /> Learn again</button>
          <button onClick={onFlashcards} className="btn btn-secondary">Back to flashcards</button>
        </div>
      </div>
    </div>
  );
}

function LearnSettingsPanel({ settings, write, onWriteChange, hasStarred, canPick, active, onChange, onClose, onRestart }: {
  settings: LearnSettings; write: boolean; onWriteChange: (v: boolean) => void; hasStarred: boolean; canPick: boolean; active: boolean;
  onChange: (p: Partial<LearnSettings>) => void; onClose: () => void; onRestart: () => void;
}) {
  const typeRows: { key: QType; label: string; hint: string }[] = [
    { key: 'flashcard', label: 'Flashcards', hint: 'Flip and rate yourself' },
    { key: 'tf', label: 'True / False', hint: 'Is this pair a match?' },
    { key: 'mc', label: 'Multiple choice', hint: 'Pick from four options' },
    { key: 'written', label: 'Written', hint: 'Type the answer — used for mastery' },
  ];
  const enabledCount = typeRows.filter(r => settings.types[r.key]).length;
  return (
    <SidePanel title="Learn options" onClose={onClose}>
      <SettingRow title="Write mode" hint="Type every answer — no multiple choice">
        <Toggle on={write} onChange={onWriteChange} />
      </SettingRow>
      <SettingRow title="Goal" hint={settings.goal === 'memorize' ? 'Two correct answers per term' : 'One correct answer per term'}>
        <Segmented value={settings.goal} onChange={v => onChange({ goal: v })}
          options={[{ value: 'memorize', label: 'Memorize' }, { value: 'cram', label: 'Cram' }]} />
      </SettingRow>
      <SettingRow title="Answer with">
        <Segmented value={settings.answerWith} onChange={v => onChange({ answerWith: v })}
          options={[{ value: 'definition', label: 'Definition' }, { value: 'term', label: 'Term' }, { value: 'both', label: 'Both' }]} />
      </SettingRow>
      <div className={`p-6 space-y-4 transition-opacity ${write ? 'opacity-40 pointer-events-none' : ''}`}>
        <div>
          <p className="font-medium text-sm">Question types</p>
          <p className="text-xs text-(--text-secondary) mt-0.5">
            {write ? 'Write mode asks only written questions.' : 'New terms start with recognition questions; familiar terms move on to written.'}
          </p>
        </div>
        {typeRows.map(r => {
          const needsPool = (r.key === 'mc' || r.key === 'tf') && !canPick;
          const on = settings.types[r.key];
          return (
            <div key={r.key} className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">{r.label}</p>
                <p className="text-xs text-(--text-secondary)">{needsPool ? 'Needs at least 2 terms' : r.hint}</p>
              </div>
              <Toggle on={on} disabled={needsPool || (on && enabledCount === 1)}
                onChange={v => onChange({ types: { ...settings.types, [r.key]: v } })} />
            </div>
          );
        })}
      </div>
      <SettingRow title="Grading" hint={
        settings.grading === 'strict' ? 'Exact spelling and accents' :
        settings.grading === 'moderate' ? 'Accepts accent slips and 1–2 letter typos, but shows you the fix' :
        'Ignores accents and forgives bigger typos'}>
        <Segmented value={settings.grading} onChange={v => onChange({ grading: v })}
          options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'moderate', label: 'Moderate' }, { value: 'strict', label: 'Strict' }]} />
      </SettingRow>
      <SettingRow title="Accept one of several answers" hint="For “to eat, to dine”, typing “to eat” is enough">
        <Toggle on={settings.anyPart} onChange={v => onChange({ anyPart: v })} />
      </SettingRow>
      <SettingRow title="Retype missed answers" hint="Type the correct answer before moving on">
        <Toggle on={settings.retypeWrong} onChange={v => onChange({ retypeWrong: v })} />
      </SettingRow>
      <SettingRow title="Study starred terms only" hint={hasStarred ? undefined : 'Star some terms first'}>
        <Toggle on={settings.starredOnly} disabled={!hasStarred} onChange={v => onChange({ starredOnly: v })} />
      </SettingRow>
      <SettingRow title="Shuffle terms">
        <Toggle on={settings.shuffle} onChange={v => onChange({ shuffle: v })} />
      </SettingRow>
      <SettingRow title="Terms per round">
        <Segmented value={String(settings.roundSize)} onChange={v => onChange({ roundSize: Number(v) })}
          options={['5', '7', '10'].map(v => ({ value: v, label: v }))} />
      </SettingRow>
      {active && (
        <div className="p-6">
          <button className="text-sm text-(--accent) font-medium hover-underline" onClick={onRestart}>Restart Learn</button>
        </div>
      )}
    </SidePanel>
  );
}
