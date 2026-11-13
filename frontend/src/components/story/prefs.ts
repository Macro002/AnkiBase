import type { DailyStoryRecipe } from '../../api';
import type { AiChoice } from './AiPanel';

/** The Story tab's choices, kept in this browser ('story-prefs', 'story-ai'), and the daily
 *  story's recipe made from them (Settings → AI → Daily story). */

export type Source = 'anki' | 'quizlet' | 'custom';
export type Cat = 'new' | 'learning' | 'relearning' | 'young' | 'mature';

export const STYLES = [
  { value: 'casual', label: 'Everyday' }, { value: 'funny', label: 'Funny' }, { value: 'adventure', label: 'Adventure' },
  { value: 'dramatic', label: 'Dramatic' }, { value: 'mystery', label: 'Mystery' }, { value: 'educational', label: 'Informative' },
  { value: 'formal', label: 'Formal' }, { value: 'custom', label: 'Custom…' },
];
export const DEFAULT_WEIGHTS: Record<Cat, number> = { learning: 5, relearning: 4, young: 2, mature: 1, new: 2 };

export const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

export interface Prefs {
  source: Source; deck: string; set: string; side: 'term' | 'definition'; field: string;
  mode: 'weighted' | 'manual'; count: number; weights: Record<Cat, number>;
  /** Quizlet smart pick: starred terms first / most-missed terms first. */
  qStarred: boolean; qMissed: boolean;
  language: string; level: string; translation: string; length: string; style: string;
}
export const DEFAULT_PREFS: Prefs = {
  source: 'anki', deck: '', set: '', side: 'term', field: '', mode: 'weighted', count: 15, weights: DEFAULT_WEIGHTS,
  qStarred: true, qMissed: true,
  language: '', level: 'B1', translation: '', length: 'auto', style: 'casual',
};

export const loadPrefs = () => store.get<Prefs>('story-prefs', DEFAULT_PREFS);
export const loadAi = () => store.get<AiChoice>('story-ai', { provider: '', model: '' });

/** What the daily story writes with: the words source (it picks new words each day with
 *  the smart pick) and the story settings. Null when there's nothing to pick from yet:
 *  typed-in words aren't kept, so it needs an Anki deck or a Quizlet set. */
export function dailyRecipe(prefs: Prefs, ai: AiChoice, setTitle?: string): DailyStoryRecipe | null {
  if (!ai.provider) return null;
  if (prefs.source === 'anki' ? !prefs.deck : prefs.source === 'quizlet' ? !prefs.set : true) return null;
  const translate = !!(prefs.translation && prefs.language);
  return {
    source: prefs.source,
    ...(prefs.source === 'anki'
      ? { deck: prefs.deck, field: prefs.field, weights: prefs.weights, deck_name: prefs.deck }
      : { set: prefs.set, side: prefs.side, q_starred: prefs.qStarred, q_missed: prefs.qMissed, deck_name: `Quizlet · ${setTitle ?? ''}` }),
    count: prefs.count,
    style: prefs.style === 'custom' ? 'casual' : prefs.style,
    length: prefs.length,
    language: translate ? prefs.translation : (prefs.language || 'auto'),
    target_language: translate ? prefs.language : undefined,
    level: prefs.level || undefined,
    provider: ai.provider, model: ai.model || undefined,
  };
}
