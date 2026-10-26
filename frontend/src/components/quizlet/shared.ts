import type { QuizletCard } from '../../api';

export type Side = 'term' | 'definition';
/** Which side the learner has to produce. 'both' picks a direction per question. */
export type AnswerWith = Side | 'both';
export type Grading = 'relaxed' | 'moderate' | 'strict';

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sample<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const decoder = typeof document !== 'undefined' ? document.createElement('textarea') : null;

export function stripHtml(html: string): string {
  const noTags = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  if (decoder) {
    decoder.innerHTML = noTags;
    return decoder.value.replace(/\s+/g, ' ').trim();
  }
  return noTags.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** The side of a card the learner sees as the prompt, given which side they answer with. */
export function promptOf(card: QuizletCard, answerSide: Side): string {
  return answerSide === 'definition' ? card.front : card.back;
}

export function answerOf(card: QuizletCard, answerSide: Side): string {
  return answerSide === 'definition' ? card.back : card.front;
}

export function resolveSide(answerWith: AnswerWith): Side {
  return answerWith === 'both' ? (Math.random() < 0.5 ? 'term' : 'definition') : answerWith;
}

// --- Grading ---------------------------------------------------------------

/** Case, punctuation, whitespace and apostrophe-style insensitive; keeps accents and any script. */
function base(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Additionally folds accents/ligatures: été → ete, cœur → coeur. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/ß/g, 'ss');
}

/** English infinitive marker: accept "eat" for "to eat". */
function dropTo(s: string): string {
  return s.replace(/^to /, '');
}

/** Edit distance where swapping two adjacent letters counts as one typo. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

function typoAllowance(len: number, grading: Grading): number {
  if (grading === 'strict' || len <= 3) return 0;
  if (grading === 'moderate') return len <= 4 ? 0 : len <= 9 ? 1 : 2;
  return Math.max(1, Math.floor(len * 0.25));
}

export interface GradeResult {
  correct: boolean;
  /** Set when accepted but not exact, so the UI can show the proper spelling. */
  note?: 'accents' | 'typo' | 'partial';
  /** Set when rejected only because of accents (strict mode) — worth calling out. */
  accentOnly?: boolean;
}

/**
 * Grade a typed answer.
 * - strict:   exact apart from case/punctuation/spacing.
 * - moderate: accent mistakes and a 1–2 letter typo are accepted but flagged.
 * - relaxed:  accents ignored and roughly a quarter of the letters may be off.
 * With `anyPart`, an answer like "to eat, to dine" also accepts "to eat".
 */
export function gradeAnswer(userRaw: string, correctHtml: string, grading: Grading, anyPart = true): GradeResult {
  const user = base(userRaw);
  if (!user) return { correct: false };
  const full = stripHtml(correctHtml);
  const candidates = [full];
  if (anyPart) {
    const parts = full.split(/\s*[;,/]\s*|\s+\|\s+/).map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) candidates.push(...parts);
  }

  let best: GradeResult = { correct: false };
  for (const [i, cand] of candidates.entries()) {
    const partial = i > 0;
    const c = base(cand);
    if (!c) continue;
    const exact = user === c || dropTo(user) === dropTo(c);
    if (exact) return partial ? { correct: true, note: 'partial' } : { correct: true };

    const uf = dropTo(fold(user)), cf = dropTo(fold(c));
    if (uf === cf) {
      if (grading === 'strict') { best = { correct: false, accentOnly: true }; continue; }
      return { correct: true, note: 'accents' };
    }
    const dist = editDistance(grading === 'strict' ? dropTo(user) : uf, grading === 'strict' ? dropTo(c) : cf);
    if (dist <= typoAllowance(cf.length, grading)) {
      return { correct: true, note: 'typo' };
    }
  }
  return best;
}

// --- Multiple-choice distractors -------------------------------------------

/**
 * Pick plausible wrong answers: unique by text, never equal to the right answer,
 * biased toward options of similar length so the right one doesn't stand out.
 */
export function pickDistractors(card: QuizletCard, pool: QuizletCard[], answerSide: Side, count: number): QuizletCard[] {
  const correctText = base(stripHtml(answerOf(card, answerSide)));
  const seen = new Set([correctText]);
  const len = correctText.length;
  const scored = shuffle(pool.filter(c => c.id !== card.id))
    .map(c => ({ c, t: base(stripHtml(answerOf(c, answerSide))) }))
    .filter(({ t }) => t && !seen.has(t) && (seen.add(t), true))
    .map(({ c, t }) => ({ c, score: Math.abs(t.length - len) / Math.max(len, 1) + Math.random() * 0.6 }));
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, count).map(s => s.c);
}

export function mcOptions(card: QuizletCard, pool: QuizletCard[], answerSide: Side, count = 4): QuizletCard[] {
  return shuffle([card, ...pickDistractors(card, pool, answerSide, count - 1)]);
}

// --- Misc ------------------------------------------------------------------

export const ACCENT_CHARS = ['é', 'è', 'ê', 'ë', 'à', 'â', 'ç', 'î', 'ï', 'ô', 'ù', 'û', 'ü', 'ÿ', 'œ', 'æ', '«', '»'];

/** True when the text uses any letter the accent bar can type — used to decide whether to show it. */
export function usesLatinAccents(texts: string[]): boolean {
  return texts.some(t => /[À-ÖØ-öø-ÿŒœ]/.test(t));
}

export function formatTime(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** Shrink long text so tiles and prompts don't overflow. */
export function sizeClass(text: string, sizes: [string, string, string] = ['text-2xl', 'text-lg', 'text-base']): string {
  const n = text.length;
  return n < 40 ? sizes[0] : n < 120 ? sizes[1] : sizes[2];
}
