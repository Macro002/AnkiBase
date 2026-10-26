import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, RotateCcw, Clock } from 'lucide-react';
import TestIcon from '../../assets/icons/brand-test.svg?react';
import { quizlet, studySessions, type QuizletCard } from '../../api';
import { useSessionSaver } from '../../hooks/useSessionSaver';
import {
  answerOf, gradeAnswer, mcOptions, pickDistractors, promptOf, resolveSide, shuffle, usesLatinAccents, formatTime,
  type AnswerWith, type Grading, type Side,
} from './shared';
import { AccentBar, Html, Segmented, Stepper, Toggle } from './ui';

type Kind = 'tf' | 'mc' | 'matching' | 'written';

const KIND_LABEL: Record<Kind, string> = { tf: 'True / False', mc: 'Multiple choice', matching: 'Matching', written: 'Written' };
const KIND_ORDER: Kind[] = ['tf', 'mc', 'matching', 'written'];
const MATCH_GROUP = 5;

interface TestConfig {
  count: number;
  answerWith: AnswerWith;
  kinds: Record<Kind, boolean>;
  instant: boolean;
  starredOnly: boolean;
  grading: Grading;
}

type Q =
  | { kind: 'tf'; id: number; side: Side; shownId: number; isTrue: boolean }
  | { kind: 'mc'; id: number; side: Side; options: number[] }
  | { kind: 'written'; id: number; side: Side }
  | { kind: 'matching'; ids: number[]; side: Side; answers: number[] };

type A =
  | { kind: 'tf'; value: boolean }
  | { kind: 'mc'; value: number }
  | { kind: 'written'; value: string; checked?: boolean }
  | { kind: 'matching'; value: Record<number, number> };

function buildTest(cards: QuizletCard[], all: QuizletCard[], cfg: TestConfig): Q[] {
  const picked = shuffle(cards).slice(0, Math.min(cfg.count, cards.length));
  let kinds = KIND_ORDER.filter(k => cfg.kinds[k]);
  if (all.length < 2) kinds = kinds.filter(k => k === 'written');
  if (kinds.length === 0) kinds = ['written'];

  // Split evenly; matching needs at least two terms or it folds into the next type.
  const per = new Map<Kind, QuizletCard[]>(kinds.map(k => [k, []]));
  picked.forEach((c, i) => per.get(kinds[i % kinds.length])!.push(c));
  if (per.has('matching') && per.get('matching')!.length < 2 && kinds.length > 1) {
    const moved = per.get('matching')!;
    per.delete('matching');
    const target = kinds.find(k => k !== 'matching')!;
    per.get(target)!.push(...moved);
  }

  const out: Q[] = [];
  for (const k of KIND_ORDER) {
    const list = per.get(k);
    if (!list?.length) continue;
    if (k === 'matching') {
      // One side per group so the answer list is consistent.
      for (let i = 0; i < list.length; i += MATCH_GROUP) {
        const group = list.slice(i, i + MATCH_GROUP);
        if (group.length === 1 && out.length && out[out.length - 1].kind === 'matching') {
          (out[out.length - 1] as Extract<Q, { kind: 'matching' }>).ids.push(group[0].id);
          (out[out.length - 1] as Extract<Q, { kind: 'matching' }>).answers.push(group[0].id);
          continue;
        }
        const side = resolveSide(cfg.answerWith);
        out.push({ kind: 'matching', ids: group.map(c => c.id), side, answers: shuffle(group.map(c => c.id)) });
      }
      continue;
    }
    for (const c of list) {
      const side = resolveSide(cfg.answerWith);
      if (k === 'tf') {
        const other = pickDistractors(c, all, side, 1)[0];
        const isTrue = !other || Math.random() < 0.5;
        out.push({ kind: 'tf', id: c.id, side, shownId: isTrue ? c.id : other.id, isTrue });
      } else if (k === 'mc') {
        out.push({ kind: 'mc', id: c.id, side, options: mcOptions(c, all, side, Math.min(4, all.length)).map(o => o.id) });
      } else {
        out.push({ kind: 'written', id: c.id, side });
      }
    }
  }
  return out;
}

/** Number of scored items in a question (matching counts each pair). */
const weight = (q: Q) => (q.kind === 'matching' ? q.ids.length : 1);

function isAnswered(q: Q, a: A | undefined): boolean {
  if (!a) return false;
  if (q.kind === 'matching' && a.kind === 'matching') return q.ids.every(id => a.value[id] != null);
  if (a.kind === 'written') return a.value.trim().length > 0;
  return true;
}

/** What an in-progress test saves so it can be resumed from the Study hub. */
interface TestSaved {
  cfg: TestConfig; questions: Q[]; answers: Record<number, A>; overrides: number[];
  onlyIds: number[] | null; startedAt: number; savedAt: number;
}

export interface TestModeProps {
  deckId: number;
  title: string;
  cards: QuizletCard[];
  favorites: Set<number>;
  onReviewed: () => void;
  onOpenMode: (mode: 'learn' | 'flashcards') => void;
}

export function TestMode({ deckId, title, cards, favorites, onReviewed, onOpenMode }: TestModeProps) {
  const [cfg, setCfg] = useState<TestConfig>({
    count: Math.min(20, cards.length),
    answerWith: 'definition',
    kinds: { tf: true, mc: true, matching: cards.length >= 4, written: true },
    instant: false,
    starredOnly: false,
    grading: 'moderate',
  });
  const [phase, setPhase] = useState<'setup' | 'test' | 'results'>('setup');
  const [questions, setQuestions] = useState<Q[]>([]);
  const [answers, setAnswers] = useState<Record<number, A>>({});
  const [overrides, setOverrides] = useState<Set<number>>(new Set());
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [onlyIds, setOnlyIds] = useState<number[] | null>(null);
  const [testId, setTestId] = useState(0);
  const [resumed, setResumed] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);
  const session = useSessionSaver('quizlet-test', deckId);

  const byId = useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);
  const showAccents = useMemo(() => usesLatinAccents(cards.flatMap(c => [c.front, c.back])), [cards]);

  const scope = useMemo(() => {
    let s = cards;
    if (onlyIds) s = cards.filter(c => onlyIds.includes(c.id));
    else if (cfg.starredOnly && favorites.size) s = cards.filter(c => favorites.has(c.id));
    return s;
  }, [cards, cfg.starredOnly, favorites, onlyIds]);

  // Resume an unfinished test, unless the cards it used have since been deleted.
  useEffect(() => {
    let cancelled = false;
    studySessions.get<TestSaved>('quizlet-test', deckId).then(({ session: sess }) => {
      const t = sess?.status === 'active' ? sess.state : null;
      if (cancelled || !t?.questions?.length) return;
      const ids = new Set(cards.map(c => c.id));
      const valid = t.questions.every(q => q.kind === 'matching'
        ? q.ids.every(i => ids.has(i))
        : ids.has(q.id) && (q.kind !== 'mc' || q.options.every(i => ids.has(i))) && (q.kind !== 'tf' || ids.has(q.shownId)));
      if (!valid) { studySessions.remove('quizlet-test', deckId).catch(() => {}); return; }
      setCfg(t.cfg);
      setQuestions(t.questions);
      setAnswers(t.answers);
      setOverrides(new Set(t.overrides));
      setOnlyIds(t.onlyIds);
      // Time away from the test doesn't count.
      setStartedAt(Date.now() - Math.max(0, t.savedAt - t.startedAt));
      setTestId(n => n + 1);
      setResumed(true);
      setPhase('test');
    }).catch(() => {});
    return () => { cancelled = true; };
    // Only on first open of this deck's Test mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const begin = (ids: number[] | null = onlyIds) => {
    setResumed(false);
    const pool = ids ? cards.filter(c => ids.includes(c.id)) : scope;
    setQuestions(buildTest(pool, cards, { ...cfg, count: ids ? ids.length : cfg.count }));
    setAnswers({});
    setTestId(t => t + 1);
    setOverrides(new Set());
    setStartedAt(Date.now());
    setPhase('test');
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const isCorrect = (qi: number, q: Q, a: A | undefined): number => {
    if (!a) return 0;
    switch (q.kind) {
      case 'tf': return a.kind === 'tf' && a.value === q.isTrue ? 1 : 0;
      case 'mc': return a.kind === 'mc' && a.value === q.id ? 1 : 0;
      case 'written':
        if (overrides.has(qi)) return 1;
        return a.kind === 'written' && gradeAnswer(a.value, answerOf(byId.get(q.id)!, q.side), cfg.grading).correct ? 1 : 0;
      case 'matching':
        return a.kind === 'matching' ? q.ids.filter(id => a.value[id] === id).length : 0;
    }
  };

  const answeredCount = questions.filter((q, i) => isAnswered(q, answers[i])).length;
  const total = questions.reduce((n, q) => n + weight(q), 0);
  const score = questions.reduce((n, q, i) => n + isCorrect(i, q, answers[i]), 0);

  useEffect(() => {
    if (phase !== 'test' || !questions.length) return;
    const state: TestSaved = { cfg, questions, answers, overrides: [...overrides], onlyIds, startedAt, savedAt: Date.now() };
    session.save({ title, detail: `${answeredCount}/${questions.length} answered`, progress_done: answeredCount, progress_total: questions.length, state });
  }, [phase, questions, answers, overrides, cfg, onlyIds, startedAt, answeredCount, title, session]);

  const exitTest = () => { session.remove(); setResumed(false); setPhase('setup'); };

  const submit = () => {
    if (answeredCount < questions.length && !confirmSubmit) { setConfirmSubmit(true); return; }
    setConfirmSubmit(false);
    session.remove();
    setResumed(false);
    setElapsed(Date.now() - startedAt);
    setPhase('results');
    // Record reviews (one per term) for the heatmap / "studied today".
    questions.forEach((q, i) => {
      const ids = q.kind === 'matching' ? q.ids : [q.id];
      ids.forEach(id => {
        const a = answers[i];
        const ok = q.kind === 'matching' ? a?.kind === 'matching' && a.value[id] === id : isCorrect(i, q, a) === 1;
        quizlet.review(deckId, id, ok ? 2 : 1).then(onReviewed).catch(() => {});
      });
    });
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const missedIds = () => {
    const ids = new Set<number>();
    questions.forEach((q, i) => {
      const a = answers[i];
      if (q.kind === 'matching') q.ids.forEach(id => { if (!(a?.kind === 'matching' && a.value[id] === id)) ids.add(id); });
      else if (isCorrect(i, q, a) === 0) ids.add(q.id);
    });
    return [...ids];
  };

  // ── setup ──────────────────────────────────────────────────────────────
  if (phase === 'setup') {
    const enabled = KIND_ORDER.filter(k => cfg.kinds[k]);
    const max = scope.length;
    return (
      <div ref={topRef} className="card space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-(--text-secondary) uppercase tracking-wider font-semibold">Practice test</p>
            <h2 className="text-2xl font-bold mt-1">Set up your test</h2>
            {onlyIds && <p className="text-sm text-(--accent) mt-1">Missed terms only ({onlyIds.length}) · <button className="hover-underline" onClick={() => setOnlyIds(null)}>use whole set</button></p>}
          </div>
          <TestIcon className="w-10 h-10 shrink-0" style={{ color: 'rgba(var(--accent-rgb), 0.5)' }} />
        </div>

        <div className="divide-y divide-white/8">
          {!onlyIds && (
            <div className="py-4 flex items-center justify-between gap-4">
              <p className="text-sm font-medium">Questions <span className="text-(--text-secondary) font-normal">(max {max})</span></p>
              <Stepper value={Math.min(cfg.count, max)} min={1} max={max} onChange={v => setCfg(c => ({ ...c, count: v }))} />
            </div>
          )}
          <div className="py-4 flex items-center justify-between gap-4">
            <p className="text-sm font-medium">Answer with</p>
            <Segmented value={cfg.answerWith} onChange={v => setCfg(c => ({ ...c, answerWith: v }))}
              options={[{ value: 'definition', label: 'Definition' }, { value: 'term', label: 'Term' }, { value: 'both', label: 'Both' }]} />
          </div>
          {KIND_ORDER.map(k => (
            <div key={k} className="py-4 flex items-center justify-between gap-4">
              <p className="text-sm font-medium">{KIND_LABEL[k]}</p>
              <Toggle on={cfg.kinds[k]} disabled={(cfg.kinds[k] && enabled.length === 1) || (k !== 'written' && cards.length < 2)}
                onChange={v => setCfg(c => ({ ...c, kinds: { ...c.kinds, [k]: v } }))} />
            </div>
          ))}
          <div className="py-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Instant feedback</p>
              <p className="text-xs text-(--text-secondary)">See if you’re right as you answer</p>
            </div>
            <Toggle on={cfg.instant} onChange={v => setCfg(c => ({ ...c, instant: v }))} />
          </div>
          <div className="py-4 flex items-center justify-between gap-4">
            <p className="text-sm font-medium">Written grading</p>
            <Segmented value={cfg.grading} onChange={v => setCfg(c => ({ ...c, grading: v }))}
              options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'moderate', label: 'Moderate' }, { value: 'strict', label: 'Strict' }]} />
          </div>
          {!onlyIds && (
            <div className="py-4 flex items-center justify-between gap-4">
              <p className={`text-sm font-medium ${favorites.size ? '' : 'text-(--text-secondary)'}`}>Starred terms only</p>
              <Toggle on={cfg.starredOnly} disabled={!favorites.size} onChange={v => setCfg(c => ({ ...c, starredOnly: v }))} />
            </div>
          )}
        </div>

        <button onClick={() => begin()} disabled={!scope.length} className="btn btn-primary w-full">Start test</button>
      </div>
    );
  }

  // ── test / results ─────────────────────────────────────────────────────
  const results = phase === 'results';
  const pct = total ? Math.round((score / total) * 100) : 0;
  const setA = (i: number, a: A) => { if (!results) setAnswers(prev => ({ ...prev, [i]: a })); };
  const locked = (i: number): boolean => {
    if (results) return true;
    if (!cfg.instant) return false;
    const a = answers[i];
    if (a?.kind === 'written') return !!a.checked;
    return isAnswered(questions[i], a);
  };
  const reveal = (i: number) => locked(i);

  return (
    <div ref={topRef} className="space-y-4">
      {results ? (
        <div className="card space-y-5">
          <div className="flex items-center gap-6 flex-wrap">
            <ScoreRing pct={pct} />
            <div className="flex-1 min-w-48 space-y-1">
              <h2 className="text-2xl font-bold">{pct === 100 ? 'Perfect score!' : pct >= 80 ? 'You’re doing great!' : pct >= 60 ? 'Nice work — keep going.' : 'Keep practicing — you’ll get there.'}</h2>
              <p className="text-sm text-(--text-secondary) flex items-center gap-4">
                <span className="text-green-400 flex items-center gap-1"><Check className="w-4 h-4" /> {score} correct</span>
                <span className="text-red-400 flex items-center gap-1"><X className="w-4 h-4" /> {total - score} incorrect</span>
                <span className="flex items-center gap-1"><Clock className="w-4 h-4" /> {formatTime(elapsed)}</span>
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {score < total && (
              <button className="btn btn-primary" onClick={() => { const ids = missedIds(); setOnlyIds(ids); begin(ids); }}>
                Retest {total - score} missed
              </button>
            )}
            <button className={`btn ${score < total ? 'btn-secondary' : 'btn-primary'} flex items-center justify-center gap-2`} onClick={() => begin()}>
              <RotateCcw className="w-4 h-4" /> New test
            </button>
            <button className="btn btn-secondary" onClick={() => onOpenMode('learn')}>Study with Learn</button>
          </div>
          <button className="text-sm text-(--accent) hover-underline" onClick={() => { setOnlyIds(null); setPhase('setup'); }}>Change test settings</button>
        </div>
      ) : (
        <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-(--bg-primary)/90 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-(--bg-tertiary) rounded-full overflow-hidden">
              <div className="h-full bg-(--accent) transition-all" style={{ width: `${(answeredCount / Math.max(questions.length, 1)) * 100}%` }} />
            </div>
            <span className="text-xs text-(--text-secondary) tabular-nums">{answeredCount}/{questions.length} answered</span>
            <button onClick={exitTest} className="text-xs text-(--text-secondary) hover-accent">Exit</button>
          </div>
          {resumed && (
            <p className="text-xs text-(--text-secondary) mt-1.5">
              Picked up where you left off · <button className="text-(--accent) hover-underline" onClick={exitTest}>discard this test</button>
            </p>
          )}
        </div>
      )}

      {questions.map((q, i) => {
        const a = answers[i];
        const ok = reveal(i) ? isCorrect(i, q, a) === weight(q) : null;
        return (
          <div key={`${testId}-${i}`} className={`card space-y-4 ${ok === true ? 'ring-1 ring-green-500/40' : ok === false ? 'ring-1 ring-red-500/40' : ''}`}>
            <div className="flex items-center justify-between text-xs text-(--text-secondary)">
              <span className="uppercase tracking-wide">{KIND_LABEL[q.kind]}</span>
              <span className="tabular-nums">{i + 1} of {questions.length}</span>
            </div>
            {q.kind === 'matching'
              ? <MatchingQ q={q} a={a?.kind === 'matching' ? a.value : {}} byId={byId} reveal={reveal(i)} locked={!!locked(i)}
                  onChange={v => setA(i, { kind: 'matching', value: v })} />
              : <SingleQ q={q} a={a} byId={byId} reveal={reveal(i)} locked={!!locked(i)} grading={cfg.grading} showAccents={showAccents}
                  overridden={overrides.has(i)} canOverride={results && q.kind === 'written' && ok === false && !!a}
                  onOverride={() => setOverrides(s => new Set(s).add(i))}
                  onChange={v => setA(i, v)} instant={cfg.instant} />}
          </div>
        );
      })}

      {!results && (
        <div className="card space-y-3 text-center">
          <p className="text-sm text-(--text-secondary)">{answeredCount === questions.length ? 'All done! Ready to see your results?' : `${questions.length - answeredCount} questions unanswered`}</p>
          {confirmSubmit
            ? <div className="flex gap-2 justify-center">
                <button className="btn btn-secondary" onClick={() => setConfirmSubmit(false)}>Keep going</button>
                <button className="btn btn-primary" onClick={submit}>Submit anyway</button>
              </div>
            : <button className="btn btn-primary w-full" onClick={submit}>Submit test</button>}
        </div>
      )}
    </div>
  );
}

function ScoreRing({ pct }: { pct: number }) {
  const size = 96, stroke = 10, r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const color = pct >= 80 ? '#4ade80' : pct >= 50 ? '#facc15' : '#f87171';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="18" fontWeight="bold">{pct}%</text>
    </svg>
  );
}

function SingleQ({ q, a, byId, reveal, locked, grading, showAccents, overridden, canOverride, onOverride, onChange, instant }: {
  q: Exclude<Q, { kind: 'matching' }>; a: A | undefined; byId: Map<number, QuizletCard>; reveal: boolean; locked: boolean;
  grading: Grading; showAccents: boolean; overridden: boolean; canOverride: boolean; onOverride: () => void;
  onChange: (a: A) => void; instant: boolean;
}) {
  const card = byId.get(q.id)!;
  const correct = answerOf(card, q.side);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(a?.kind === 'written' ? a.value : '');
  const opt = (sel: boolean, right: boolean) => reveal
    ? right ? 'bg-green-500/15 ring-1 ring-green-500/60' : sel ? 'bg-red-500/15 ring-1 ring-red-500/60' : 'bg-(--bg-tertiary) opacity-50'
    : sel ? 'bg-(--accent)/15 ring-1 ring-(--accent)' : 'bg-(--bg-tertiary) hover:bg-white/8';

  return (
    <>
      <Html html={promptOf(card, q.side)} className="text-xl font-medium leading-snug" />
      {q.kind === 'tf' && (
        <>
          <div className="border-l-2 border-white/15 pl-3">
            <Html html={answerOf(byId.get(q.shownId)!, q.side)} className="text-lg leading-snug" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[true, false].map(v => (
              <button key={String(v)} disabled={locked} onClick={() => onChange({ kind: 'tf', value: v })}
                className={`rounded-xl p-3 text-sm font-semibold transition-all ${opt(a?.kind === 'tf' && a.value === v, v === q.isTrue)}`}>
                {v ? 'True' : 'False'}
              </button>
            ))}
          </div>
          {reveal && !q.isTrue && <p className="text-sm text-(--text-secondary)">Correct match: <Html html={correct} className="inline text-white font-semibold" /></p>}
        </>
      )}
      {q.kind === 'mc' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {q.options.map(id => (
            <button key={id} disabled={locked} onClick={() => onChange({ kind: 'mc', value: id })}
              className={`rounded-xl p-3 text-left text-sm font-medium transition-all ${opt(a?.kind === 'mc' && a.value === id, id === q.id)}`}>
              <Html html={answerOf(byId.get(id)!, q.side)} />
            </button>
          ))}
        </div>
      )}
      {q.kind === 'written' && (
        <div className="space-y-2">
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (instant && draft.trim()) onChange({ kind: 'written', value: draft, checked: true }); }}>
            <input ref={inputRef} type="text" value={draft} disabled={locked} placeholder="Type the answer"
              autoComplete="off" spellCheck={false}
              onChange={e => { setDraft(e.target.value); if (!instant) onChange({ kind: 'written', value: e.target.value }); }}
              className="input flex-1 py-2.5" />
            {instant && !locked && <button type="submit" disabled={!draft.trim()} className="btn btn-primary disabled:opacity-40">Check</button>}
          </form>
          {showAccents && !locked && <AccentBar inputRef={inputRef} onInsert={v => { setDraft(v); if (!instant) onChange({ kind: 'written', value: v }); }} />}
          {reveal && (() => {
            const g = a?.kind === 'written' ? gradeAnswer(a.value, correct, grading) : { correct: false };
            const right = g.correct || overridden;
            return (
              <div className={`rounded-lg p-3 text-sm ${right ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                {right
                  ? <p className="text-green-400 font-medium">{overridden ? 'Marked correct' : g.note ? 'Correct — exact answer: ' : 'Correct'}{!overridden && g.note && <Html html={correct} className="inline text-white" />}</p>
                  : <>
                      <p className="text-(--text-secondary) text-xs">Correct answer</p>
                      <Html html={correct} className="font-semibold" />
                      {canOverride && <button onClick={onOverride} className="text-xs text-(--accent) hover-underline mt-2">Override: I was correct</button>}
                    </>}
              </div>
            );
          })()}
        </div>
      )}
    </>
  );
}

function MatchingQ({ q, a, byId, reveal, locked, onChange }: {
  q: Extract<Q, { kind: 'matching' }>; a: Record<number, number>; byId: Map<number, QuizletCard>;
  reveal: boolean; locked: boolean; onChange: (v: Record<number, number>) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const letter = (id: number) => String.fromCharCode(65 + q.answers.indexOf(id));
  const usedBy = (ansId: number) => Object.entries(a).find(([, v]) => v === ansId)?.[0];

  const assign = (promptId: number, ansId: number) => {
    const next = { ...a };
    const prev = usedBy(ansId);
    if (prev) delete next[Number(prev)];
    next[promptId] = ansId;
    onChange(next);
    setActive(null);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-(--text-secondary)">Select a prompt, then the {q.side === 'definition' ? 'definition' : 'term'} that matches it.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          {q.ids.map(id => {
            const chosen = a[id];
            const right = chosen === id;
            return (
              <button key={id} disabled={locked} onClick={() => setActive(active === id ? null : id)}
                className={`w-full rounded-xl p-3 text-left text-sm flex items-start gap-3 transition-all ${
                  reveal ? (right ? 'bg-green-500/15' : 'bg-red-500/15') : active === id ? 'bg-(--accent)/15 ring-1 ring-(--accent)' : 'bg-(--bg-tertiary) hover:bg-white/8'}`}>
                <span className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold ${chosen != null ? 'bg-(--accent) text-white' : 'bg-white/10 text-(--text-secondary)'}`}>
                  {chosen != null ? letter(chosen) : '–'}
                </span>
                <div className="min-w-0">
                  <Html html={promptOf(byId.get(id)!, q.side)} className="font-medium" />
                  {reveal && !right && <p className="text-xs text-(--text-secondary) mt-1">Answer: {letter(id)}</p>}
                </div>
              </button>
            );
          })}
        </div>
        <div className="space-y-2">
          {q.answers.map(id => {
            const taken = usedBy(id) != null;
            return (
              <button key={id} disabled={locked || active == null} onClick={() => active != null && assign(active, id)}
                className={`w-full rounded-xl p-3 text-left text-sm flex items-start gap-3 transition-all ${
                  active != null && !locked ? 'bg-(--bg-tertiary) hover:bg-(--accent)/15 cursor-pointer' : 'bg-(--bg-tertiary)'} ${taken && !reveal ? 'opacity-50' : ''}`}>
                <span className="shrink-0 w-7 h-7 rounded-md bg-white/10 flex items-center justify-center text-xs font-bold">{letter(id)}</span>
                <Html html={answerOf(byId.get(id)!, q.side)} className="min-w-0" />
              </button>
            );
          })}
        </div>
      </div>
      {!reveal && Object.keys(a).length > 0 && !locked && (
        <button className="text-xs text-(--text-secondary) hover-accent" onClick={() => onChange({})}>Clear matches</button>
      )}
    </div>
  );
}
