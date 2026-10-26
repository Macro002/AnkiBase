/**
 * Learn mode engine — pure state transitions, no React.
 *
 * Modelled on Quizlet Learn:
 *  - Terms move New → Familiar → Mastered. "Seen" = attempted but missed.
 *  - Memorize goal: a term needs two correct answers, in separate rounds — first an
 *    easier recognition question (multiple choice / true-false / flashcard), then a
 *    harder recall question (written) once it is Familiar. A miss drops it back.
 *  - Cram goal: one correct answer per term is enough.
 *  - Work happens in rounds of ~7 terms. Inside a round every term is asked until it is
 *    answered correctly once; misses come back at the end of the round. After each
 *    round there is a summary, then the next round tops the working set back up.
 *  - State is plain JSON so it can be saved server-side and resumed later.
 */

import type { AnswerWith, Grading } from './shared';

export type QType = 'flashcard' | 'tf' | 'mc' | 'written';
export type Goal = 'memorize' | 'cram';
export type Level = 0 | 1 | 2 | 3; // new, seen (missed), familiar, mastered

export const LEVEL_LABEL: Record<Level, string> = { 0: 'Not studied', 1: 'Still learning', 2: 'Familiar', 3: 'Mastered' };

export interface LearnSettings {
  goal: Goal;
  answerWith: AnswerWith;
  types: Record<QType, boolean>;
  shuffle: boolean;
  starredOnly: boolean;
  grading: Grading;
  anyPart: boolean;
  retypeWrong: boolean;
  roundSize: number;
}

export const DEFAULT_SETTINGS: LearnSettings = {
  goal: 'memorize',
  answerWith: 'definition',
  types: { flashcard: false, tf: true, mc: true, written: true },
  shuffle: true,
  starredOnly: false,
  grading: 'moderate',
  anyPart: true,
  retypeWrong: false,
  roundSize: 7,
};

export interface TermProgress {
  level: Level;
  correct: number;
  wrong: number;
  /** null until first asked. */
  firstTry: boolean | null;
  lastAsked: number;
  lastType?: QType;
}

export interface RoundState {
  number: number;
  /** Terms in this round's working set, in the order they were first asked. */
  ids: number[];
  /** Questions still to ask this round (ids; may repeat a missed id). */
  queue: number[];
  /** Per-term results within this round. */
  results: Record<number, boolean[]>;
}

export type LearnStatus = 'active' | 'summary' | 'complete';

export interface LearnState {
  version: 1;
  settings: LearnSettings;
  /** All term ids in study scope, in study order. */
  order: number[];
  terms: Record<number, TermProgress>;
  round: RoundState;
  status: LearnStatus;
  asked: number;
  startedAt: number;
  finishedAt?: number;
}

const freshTerm = (): TermProgress => ({ level: 0, correct: 0, wrong: 0, firstTry: null, lastAsked: -1 });

export function isMastered(t: TermProgress | undefined): boolean {
  return !!t && t.level === 3;
}

function inScope(ids: number[], settings: LearnSettings, starred: Set<number>): number[] {
  if (!settings.starredOnly || starred.size === 0) return ids;
  const s = ids.filter(id => starred.has(id));
  return s.length ? s : ids;
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createState(cardIds: number[], settings: LearnSettings, starred: Set<number>): LearnState {
  const scope = inScope(cardIds, settings, starred);
  const order = settings.shuffle ? shuffled(scope) : scope;
  const terms: Record<number, TermProgress> = {};
  order.forEach(id => { terms[id] = freshTerm(); });
  const s: LearnState = {
    version: 1, settings, order, terms,
    round: { number: 0, ids: [], queue: [], results: {} },
    status: 'active', asked: 0, startedAt: Date.now(),
  };
  return startRound(s);
}

/**
 * Bring a saved state in line with the current deck: drop deleted cards, add new
 * ones as Not studied, and respect a changed "starred only" scope.
 */
export function reconcile(state: LearnState, cardIds: number[], starred: Set<number>): LearnState {
  const settings = { ...DEFAULT_SETTINGS, ...state.settings, types: { ...DEFAULT_SETTINGS.types, ...state.settings.types } };
  const scope = new Set(inScope(cardIds, settings, starred));
  const order = state.order.filter(id => scope.has(id));
  const added = cardIds.filter(id => scope.has(id) && !order.includes(id));
  const newOrder = [...order, ...(settings.shuffle ? shuffled(added) : added)];
  const terms: Record<number, TermProgress> = {};
  newOrder.forEach(id => { terms[id] = state.terms[id] ?? freshTerm(); });
  const keep = (id: number) => scope.has(id);
  const round: RoundState = {
    ...state.round,
    ids: state.round.ids.filter(keep),
    queue: state.round.queue.filter(keep),
  };
  let next: LearnState = { ...state, settings, order: newOrder, terms, round };
  const allMastered = newOrder.every(id => isMastered(terms[id]));
  if (allMastered && newOrder.length) next.status = 'complete';
  else if (next.status === 'complete') next = startRound({ ...next, status: 'active', finishedAt: undefined });
  else if (next.status === 'active' && next.round.queue.length === 0) next = startRound(next);
  return next;
}

/** Fill the next round: in-progress terms first (least recently asked), then new ones. */
export function startRound(state: LearnState): LearnState {
  const { order, terms, settings } = state;
  const unmastered = order.filter(id => !isMastered(terms[id]));
  if (unmastered.length === 0) {
    return { ...state, status: 'complete', finishedAt: state.finishedAt ?? Date.now() };
  }
  const inProgress = unmastered
    .filter(id => terms[id].level > 0)
    .sort((a, b) => terms[a].lastAsked - terms[b].lastAsked);
  const fresh = unmastered.filter(id => terms[id].level === 0);
  const size = Math.max(1, settings.roundSize);
  const ids = [...inProgress, ...fresh].slice(0, size);

  let queue = shuffled(ids);
  // Don't open a round with the question that just closed the previous one.
  const lastId = state.round.queue.length === 0 ? lastAskedId(state) : undefined;
  if (queue.length > 1 && queue[0] === lastId) [queue[0], queue[1]] = [queue[1], queue[0]];
  if (!settings.shuffle) queue = ids.slice();

  return {
    ...state,
    status: 'active',
    round: { number: state.round.number + 1, ids, queue, results: {} },
  };
}

function lastAskedId(state: LearnState): number | undefined {
  let best: number | undefined, t = -1;
  for (const id of state.order) {
    if (state.terms[id].lastAsked > t) { t = state.terms[id].lastAsked; best = id; }
  }
  return best;
}

export function currentId(state: LearnState): number | null {
  return state.status === 'active' ? state.round.queue[0] ?? null : null;
}

const EASY: QType[] = ['mc', 'tf', 'flashcard'];

/**
 * Pick the question type for a term from its level.
 * Not studied / still learning → a recognition question; Familiar → written recall.
 * Cram mixes everything enabled. Falls back gracefully when types are disabled.
 */
export function questionType(state: LearnState, id: number, poolSize: number): QType {
  const { types, goal } = state.settings;
  const t = state.terms[id];
  // Multiple choice and true/false need other cards to draw wrong answers from.
  const ok = (q: QType) => types[q] && (q === 'written' || q === 'flashcard' || poolSize >= 2);
  const enabled = (['mc', 'tf', 'flashcard', 'written'] as QType[]).filter(ok);
  if (enabled.length === 0) return poolSize >= 2 ? 'mc' : 'flashcard';

  if (goal === 'cram') {
    const choices = enabled.length > 1 && t.lastType ? enabled.filter(q => q !== t.lastType) : enabled;
    return choices[Math.floor(Math.random() * choices.length)];
  }

  const easy = EASY.filter(ok);
  if (t.level >= 2) {
    if (ok('written')) return 'written';
    // No written: ask a different recognition type than last time if possible.
    const other = easy.filter(q => q !== t.lastType);
    return (other.length ? other : easy)[Math.floor(Math.random() * (other.length || easy.length))];
  }
  if (easy.length) {
    // Prefer multiple choice for brand-new terms; vary after a miss.
    if (t.level === 0 && ok('mc')) return 'mc';
    const other = easy.filter(q => q !== t.lastType);
    const pick = other.length ? other : easy;
    return pick[Math.floor(Math.random() * pick.length)];
  }
  return 'written';
}

/** Apply an answer to the current question. */
export function answer(state: LearnState, correct: boolean, qtype: QType): LearnState {
  const id = currentId(state);
  if (id == null) return state;
  const prev = state.terms[id];
  const t: TermProgress = {
    ...prev,
    correct: prev.correct + (correct ? 1 : 0),
    wrong: prev.wrong + (correct ? 0 : 1),
    firstTry: prev.firstTry ?? correct,
    lastAsked: state.asked,
    lastType: qtype,
  };

  if (correct) {
    if (state.settings.goal === 'cram') t.level = 3;
    else t.level = prev.level >= 2 ? 3 : 2;
  } else {
    t.level = 1;
  }

  const rest = state.round.queue.slice(1);
  // A miss comes back at the end of the round; a hit is done for this round.
  const queue = correct ? rest : [...rest, id];
  const results = { ...state.round.results, [id]: [...(state.round.results[id] ?? []), correct] };

  const next: LearnState = {
    ...state,
    asked: state.asked + 1,
    terms: { ...state.terms, [id]: t },
    round: { ...state.round, queue, results },
  };

  if (queue.length === 0) {
    const done = next.order.every(i => isMastered(next.terms[i]));
    return done
      ? { ...next, status: 'complete', finishedAt: Date.now() }
      : { ...next, status: 'summary' };
  }
  return next;
}

export function continueAfterSummary(state: LearnState): LearnState {
  return state.status === 'summary' ? startRound(state) : state;
}

export interface Counts { notStudied: number; learning: number; familiar: number; mastered: number; total: number }

export function counts(state: LearnState): Counts {
  const c: Counts = { notStudied: 0, learning: 0, familiar: 0, mastered: 0, total: state.order.length };
  for (const id of state.order) {
    const l = state.terms[id].level;
    if (l === 0) c.notStudied++;
    else if (l === 1) c.learning++;
    else if (l === 2) c.familiar++;
    else c.mastered++;
  }
  return c;
}

/** Overall progress 0..1. Memorize: two steps per term. Cram: one. */
export function progress(state: LearnState): number {
  const total = state.order.length;
  if (!total) return 0;
  if (state.settings.goal === 'cram') return counts(state).mastered / total;
  let pts = 0;
  for (const id of state.order) {
    const l = state.terms[id].level;
    pts += l === 3 ? 2 : l === 2 ? 1 : 0;
  }
  return pts / (total * 2);
}

/** Progress inside the current round: answered-correctly terms / terms in round. */
export function roundProgress(state: LearnState): { done: number; total: number } {
  const { ids, results } = state.round;
  const done = ids.filter(id => (results[id] ?? []).includes(true)).length;
  return { done, total: ids.length };
}

export function levels(state: LearnState): Map<number, Level> {
  return new Map(state.order.map(id => [id, state.terms[id].level]));
}
