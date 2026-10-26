/**
 * Text helpers shared by Story (preview) and Reading: finding vocabulary in a story
 * (including the inflected forms the AI reports, and phrases like "le chat") and
 * splitting text into clickable words.
 */

const ARTICLE = /^(?:le |la |les |l['’]|un |une |des |du |de la |de l['’]|der |die |das |el |los |las |il |lo |gli |the |a |an |to )/i;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export const fold = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/’/g, "'");

export const stripArticle = (s: string) => s.replace(ARTICLE, '').trim();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Accent-insensitive regex source for a literal: "été" also matches "ete". */
function looseSource(s: string): string {
  return [...s].map(ch => {
    const base = fold(ch);
    if (base === fold(ch.toUpperCase()) && /\p{L}/u.test(ch) && base !== ch.toLowerCase()) {
      return `(?:${esc(ch)}|${esc(base)})`;
    }
    if (ch === "'" || ch === '’') return "['’]";
    return esc(ch);
  }).join('');
}

export interface Vocab {
  /** Matches any vocab word or form in running text (global, case-insensitive, unicode). */
  regex: RegExp | null;
  /** folded surface form -> vocab word it belongs to */
  owner: Map<string, string>;
}

export function buildVocab(words: string[], forms: Record<string, string[]> = {}): Vocab {
  const owner = new Map<string, string>();
  const originals = new Map<string, string>(); // folded -> original spelling (for the regex)
  for (const w of words) {
    const cands = new Set([w, stripArticle(w), ...(forms[w] ?? [])].map(x => x.trim()).filter(x => x.length > 0));
    for (const c of cands) {
      if (!owner.has(fold(c))) { owner.set(fold(c), w); originals.set(fold(c), c); }
    }
  }
  // Longest first, so "le chat" wins over "chat".
  const surfaces = [...originals.values()].sort((a, b) => b.length - a.length);
  if (!surfaces.length) return { regex: null, owner };
  // Words in spaced scripts need word boundaries; CJK words can't have them.
  const spaced = surfaces.filter(s => !CJK.test(s)).map(looseSource);
  const cjk = surfaces.filter(s => CJK.test(s)).map(esc);
  const parts = [];
  if (spaced.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${spaced.join('|')})(?![\\p{L}\\p{N}])`);
  if (cjk.length) parts.push(`(?:${cjk.join('|')})`);
  return { regex: new RegExp(parts.join('|'), 'giu'), owner };
}

export interface Piece { text: string; vocab?: string; word?: boolean }

/** Split a line into vocab hits, other words and the stuff between them. */
export function splitLine(line: string, vocab: Vocab): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  if (vocab.regex) {
    vocab.regex.lastIndex = 0;
    for (const m of line.matchAll(vocab.regex)) {
      if (m.index! > last) out.push(...tokenize(line.slice(last, m.index)));
      out.push({ text: m[0], vocab: vocab.owner.get(fold(m[0])) ?? m[0], word: true });
      last = m.index! + m[0].length;
    }
  }
  if (last < line.length) out.push(...tokenize(line.slice(last)));
  return out;
}

// French/Italian elisions (l', d', qu', jusqu'…) are words of their own; a few words keep their apostrophe.
const KEEP_APOSTROPHE = "aujourd['’]hui|presqu['’]île|prud['’]hom\\p{L}*|quelqu['’]un\\p{L}*";
const WORD = new RegExp(
  `(?:${KEEP_APOSTROPHE})|[\\p{Script=Han}]+|[\\p{Script=Hiragana}]+|[\\p{Script=Katakana}ー]+|` +
  `\\p{L}{1,6}['’](?=\\p{L})|[\\p{L}\\p{M}\\p{N}]+(?:-[\\p{L}\\p{M}\\p{N}]+)*`,
  'giu',
);

export function tokenize(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], word: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Paragraphs of a story; lines starting with ">> " are translations of the paragraph before. */
export function paragraphs(content: string): { text: string; translation?: string }[] {
  const out: { text: string; translation?: string }[] = [];
  for (const block of content.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const main = lines.filter(l => !l.startsWith('>>')).join(' ').replace(/\*\*/g, '');
    const tr = lines.filter(l => l.startsWith('>>')).map(l => l.replace(/^>>\s?/, '')).join(' ');
    if (!main && tr && out.length) { out[out.length - 1].translation = [out[out.length - 1].translation, tr].filter(Boolean).join(' '); continue; }
    out.push(tr ? { text: main, translation: tr } : { text: main });
  }
  return out;
}

/** Best-effort BCP-47 code for speech synthesis. */
export const LANG_CODE: Record<string, string> = {
  French: 'fr-FR', Japanese: 'ja-JP', German: 'de-DE', Spanish: 'es-ES', Italian: 'it-IT', Portuguese: 'pt-PT',
  English: 'en-US', Korean: 'ko-KR', Chinese: 'zh-CN', Russian: 'ru-RU', Dutch: 'nl-NL',
};
