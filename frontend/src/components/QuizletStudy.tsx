import { useState, useEffect, useRef, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Star, ChevronLeft, ChevronRight, ChevronDown,
  Undo2, Settings, X, Check,
  TrendingUp, Lightbulb, BookOpen, Pencil, RotateCcw,
} from 'lucide-react';
import { Flashcard, useFlashcard } from 'react-quizlet-flashcard';
import 'react-quizlet-flashcard/dist/index.css';
import FlashcardsIcon from '../assets/icons/brand-flashcards.svg?react';
import LearnIcon      from '../assets/icons/brand-learn.svg?react';
import TestIcon       from '../assets/icons/brand-test.svg?react';
import BlocksIcon     from '../assets/icons/brand-blocks.svg?react';
import BlastIcon      from '../assets/icons/brand-blast.svg?react';
import MatchIcon      from '../assets/icons/brand-match.svg?react';
import { quizlet, type QuizletCard } from '../api';

const PALETTE = ['#f87171','#fb923c','#fbbf24','#4ade80','#60a5fa','#c084fc','#f472b6','#ffffff'];

function FormatToolbar() {
  const exec = (cmd: string, val?: string) => document.execCommand(cmd, false, val);
  return (
    <div className="flex items-center gap-1 mb-1.5 flex-wrap">
      <button onMouseDown={e => { e.preventDefault(); exec('bold'); }}
        className="w-7 h-7 rounded flex items-center justify-center bg-(--bg-tertiary) hover-bg-accent transition-colors font-bold text-sm">B</button>
      <button onMouseDown={e => { e.preventDefault(); exec('italic'); }}
        className="w-7 h-7 rounded flex items-center justify-center bg-(--bg-tertiary) hover-bg-accent transition-colors italic text-sm">I</button>
      <button onMouseDown={e => { e.preventDefault(); exec('underline'); }}
        className="w-7 h-7 rounded flex items-center justify-center bg-(--bg-tertiary) hover-bg-accent transition-colors underline text-sm">U</button>
      <div className="w-px h-5 bg-(--bg-tertiary) mx-0.5" />
      {PALETTE.map(color => (
        <button key={color} onMouseDown={e => { e.preventDefault(); exec('foreColor', color); }}
          className="w-5 h-5 rounded-full border-2 border-transparent hover:scale-110 transition-transform"
          style={{ background: color, boxShadow: color === '#ffffff' ? 'inset 0 0 0 1px #666' : undefined }} />
      ))}
      <div className="w-px h-5 bg-(--bg-tertiary) mx-0.5" />
      <button onMouseDown={e => { e.preventDefault(); exec('removeFormat'); }}
        className="px-2 h-7 rounded bg-(--bg-tertiary) hover-bg-accent transition-colors text-xs text-(--text-secondary)">Clear</button>
    </div>
  );
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function DonutChart({ percent }: { percent: number }) {
  const size = 96, stroke = 10;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - percent / 100);
  const color = percent >= 80 ? '#4ade80' : percent >= 50 ? '#facc15' : '#f87171';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="middle"
        fill="white" fontSize="16" fontWeight="bold">{percent}%</text>
    </svg>
  );
}

// --- Learn mode types & helpers ---
type LearnQtype = 'mc' | 'written' | 'flashcard';
type LearnPhase = 'off' | 'goal-pick' | 'session' | 'end';

interface LearnConfig {
  mc: boolean;
  written: boolean;
  answerWith: 'term' | 'definition';
  grading: 'relaxed' | 'moderate' | 'strict';
  retypeWrong: boolean;
  goal: 'cram' | 'memorize';
}

interface LearnQItem { card: QuizletCard; qtype: LearnQtype; }

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').trim();
}

function gradeAnswer(userRaw: string, correctHtml: string, grading: 'relaxed' | 'moderate' | 'strict'): boolean {
  const correct = stripHtml(correctHtml);
  const user = userRaw.trim();
  if (!user) return false;
  if (grading === 'strict') {
    const n = (s: string) => s.toLowerCase().replace(/\(.*?\)/g,'').replace(/[,.:;!?]/g,'').replace(/\s+/g,' ').trim();
    return n(user) === n(correct);
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
  const threshold = grading === 'moderate'
    ? Math.max(1, Math.floor(correct.length * 0.15))
    : Math.max(2, Math.floor(correct.length * 0.30));
  return levenshtein(norm(user), norm(correct)) <= threshold;
}

function getQtypes(config: LearnConfig): LearnQtype[] {
  const t: LearnQtype[] = [];
  if (config.mc) t.push('mc');
  if (config.written) t.push('written');
  t.push('flashcard');
  return t;
}

function getMCOptions(card: QuizletCard, allCards: QuizletCard[]): QuizletCard[] {
  const others = shuffle(allCards.filter(c => c.id !== card.id));
  return shuffle([card, ...others.slice(0, Math.min(3, others.length))]);
}

const MODES = [
  { id: 'flashcards', label: 'Flashcards', Icon: FlashcardsIcon, active: true  },
  { id: 'learn',      label: 'Learn',      Icon: LearnIcon,      active: true  },
  { id: 'test',       label: 'Test',       Icon: TestIcon,       active: false },
  { id: 'blocks',     label: 'Blocks',     Icon: BlocksIcon,     active: false },
  { id: 'blast',      label: 'Blast',      Icon: BlastIcon,      active: false },
  { id: 'match',      label: 'Match',      Icon: MatchIcon,      active: false },
];

// desktop: 3-col grid, icon left + label right
// mobile: rendered separately below progress bar as 2-col grid, icon+label stacked
function ModeGrid({ mobile = false, activeMode = 'flashcards', onModeClick }: { mobile?: boolean; activeMode?: string; onModeClick?: (id: string) => void }) {
  return (
    <div className={mobile ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-3 gap-2'}>
      {MODES.map(({ id, label, Icon, active }) => {
        const isCurrent = id === activeMode;
        return (
          <button
            key={id}
            disabled={!active}
            onClick={active ? () => onModeClick?.(id) : undefined}
            title={active ? undefined : 'Coming soon'}
            className={`rounded-lg font-medium transition-colors ${
              mobile
                ? 'flex flex-col items-center justify-center gap-1.5 py-4 px-2 text-xs'
                : 'flex items-center gap-3 px-4 py-3 text-sm'
            } ${
              !active
                ? 'bg-(--bg-secondary) text-(--text-secondary) opacity-40 cursor-not-allowed'
                : isCurrent
                ? 'bg-(--accent)/10 text-(--accent)'
                : 'bg-(--bg-secondary) text-(--text-secondary) hover:bg-(--bg-tertiary) hover:text-white'
            }`}
          >
            <Icon
              className={mobile ? 'w-8 h-8' : 'w-6 h-6'}
              style={{ color: active ? 'rgba(var(--accent-rgb), 0.55)' : undefined }}
            />
            {label}
          </button>
        );
      })}
    </div>
  );
}

interface EndScreenProps {
  title: string; total: number; known: Set<number>; unknown: Set<number>;
  onRestart: () => void; onRestartUnknown: () => void; onBack: () => void;
}

function EndScreen({ title, total, known, unknown, onRestart, onRestartUnknown, onBack }: EndScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const myConfetti = confetti.create(canvasRef.current, { resize: true });
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const hover  = getComputedStyle(document.documentElement).getPropertyValue('--accent-hover').trim();
    const colors = [accent, hover, '#ffffff'];
    myConfetti({ particleCount: 80, angle: 65,  spread: 55, origin: { x: 0, y: 1 }, colors });
    myConfetti({ particleCount: 80, angle: 115, spread: 55, origin: { x: 1, y: 1 }, colors });
    return () => myConfetti.reset();
  }, []);

  const knownCount = known.size;
  const unknownCount = unknown.size;
  const leftCount = Math.max(0, total - knownCount - unknownCount);
  const percent = total > 0 ? Math.round((knownCount / total) * 100) : 0;
  const msg = percent === 100 ? "Perfect! You know them all!"
    : percent >= 80 ? "Impressive! Just a bit more to go!"
    : percent >= 60 ? "Good progress! Keep it up!"
    : "Keep practicing — you're getting there!";

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-8">
      <button onClick={onBack} className="flex items-center gap-2 text-(--text-secondary) hover-accent text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Decks
      </button>
      <h1 className="text-2xl font-bold">{title}</h1>
      <ModeGrid />
      <div className="card relative overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
        <div className="relative">
          <h2 className="text-2xl font-bold mb-6">{msg}</h2>
          <div className="flex flex-col sm:flex-row gap-8">
            <div className="flex-1">
              <p className="text-sm text-(--text-secondary) font-medium mb-4">How you're doing</p>
              <div className="flex items-center gap-6">
                <DonutChart percent={percent} />
                <div className="space-y-2 flex-1">
                  {[
                    { label: 'Know', count: knownCount, color: 'bg-green-500' },
                    { label: 'Still learning', count: unknownCount, color: 'bg-orange-500' },
                    ...(leftCount > 0 ? [{ label: 'Terms left', count: leftCount, color: 'bg-(--bg-tertiary)' }] : []),
                  ].map(({ label, count, color }) => (
                    <div key={label}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="flex items-center gap-2">
                          <span className={`w-3 h-3 rounded-sm inline-block ${color}`} />{label}
                        </span>
                        <span className="font-semibold">{count}</span>
                      </div>
                      <div className="w-full bg-(--bg-tertiary) rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full transition-all ${color}`}
                          style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex-1">
              <p className="text-sm text-(--text-secondary) font-medium mb-4">Next steps</p>
              <div className="space-y-3">
                <button className="btn w-full flex items-center justify-center gap-2 opacity-40 cursor-not-allowed bg-(--bg-tertiary)" disabled title="Coming soon">
                  <BookOpen className="w-4 h-4" /> Practice with questions
                </button>
                {unknownCount > 0 && (
                  <button className="btn btn-secondary w-full" onClick={onRestartUnknown}>
                    Focus on {unknownCount} still learning
                  </button>
                )}
                <button className="text-sm text-(--accent) hover-underline w-full text-center" onClick={onRestart}>
                  Restart Flashcards
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


export function QuizletStudy() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const deckId = Number(id);

  const [title, setTitle] = useState('');
  const [cards, setCards] = useState<QuizletCard[]>([]);
  const [queue, setQueue] = useState<QuizletCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [studiedToday, setStudiedToday] = useState(0);

  const [listFilter, setListFilter] = useState<'all' | 'favorites' | 'learning' | 'mastered' | 'alpha'>('all');
  const [listSearch, setListSearch] = useState('');
  const [expandedImage, setExpandedImage] = useState<{
    src: string;
    fromRect: { top: number; left: number; width: number; height: number };
    phase: 'from' | 'to' | 'closing';
  } | null>(null);

  const [index, setIndex] = useState(0);
  const flipHook = useFlashcard({ flipDirection: 'bt' });
  const flipped = flipHook.state === 'back';
  const [hintShown, setHintShown] = useState(false);
  const [slideDir, setSlideDir] = useState<'right' | 'left'>('right');
  const prevIndexRef = useRef(0);

  const [favorites, setFavorites] = useState<Set<number>>(new Set());

  const [trackProgress, setTrackProgress] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const [unknown, setUnknown] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<Array<{ cardId: number; wasKnown: boolean }>>([]);
  const [sessionDone, setSessionDone] = useState(false);

  const [feedback, setFeedback] = useState<'known' | 'unknown' | null>(null);

  const [showOptions, setShowOptions] = useState(false);
  const [closingOptions, setClosingOptions] = useState(false);
  const [studyStarredOnly, setStudyStarredOnly] = useState(false);
  const [frontSide, setFrontSide] = useState<'term' | 'definition'>('term');
  const [showShortcuts, setShowShortcuts] = useState(false);

  const [isShuffled, setIsShuffled] = useState(false);
  const [isAutoplay, setIsAutoplay] = useState(false);
  const autoplayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const trackProgressIndexRef = useRef(0);

  const [editingCard, setEditingCard] = useState<QuizletCard | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editImageUrl, setEditImageUrl] = useState('');
  const frontEditRef = useRef<HTMLDivElement>(null);
  const backEditRef = useRef<HTMLDivElement>(null);

  // Learn mode state
  const [learnPhase, setLearnPhase] = useState<LearnPhase>('off');
  const [learnConfig, setLearnConfig] = useState<LearnConfig>({
    mc: true, written: true, answerWith: 'definition',
    grading: 'relaxed', retypeWrong: false, goal: 'memorize',
  });
  const [learnQueue, setLearnQueue] = useState<LearnQItem[]>([]);
  const [learnQIdx, setLearnQIdx] = useState(0);
  const [learnStages, setLearnStages] = useState<Map<number, number>>(new Map());
  const [learnMastered, setLearnMastered] = useState<Set<number>>(new Set());
  const [learnFinalResult, setLearnFinalResult] = useState<Map<number, boolean>>(new Map());
  const [learnMCOptions, setLearnMCOptions] = useState<QuizletCard[]>([]);
  const [learnMCSelected, setLearnMCSelected] = useState<number | null>(null);
  const [learnShowResult, setLearnShowResult] = useState(false);
  const [learnWrittenText, setLearnWrittenText] = useState('');
  const [learnWrittenResult, setLearnWrittenResult] = useState<'correct' | 'wrong' | null>(null);
  const [learnNeedRetype, setLearnNeedRetype] = useState(false);
  const [learnRetypeText, setLearnRetypeText] = useState('');
  const [learnFlipped, setLearnFlipped] = useState(false);
  const [showRestartLearnConfirm, setShowRestartLearnConfirm] = useState(false);
  const [showLearnOptions, setShowLearnOptions] = useState(false);
  const learnAdvanceRef = useRef<(wasCorrect: boolean) => void>(() => {});
  const learnWrittenRef = useRef<HTMLInputElement>(null);

  const current = queue[index];

  useEffect(() => {
    Promise.all([quizlet.getDeck(deckId), quizlet.deckStats(deckId), quizlet.getFavorites(deckId)]).then(([deck, stats, favs]) => {
      setTitle(deck.title);
      setCards(deck.cards);
      setQueue(deck.cards);
      setStudiedToday(stats.studied_today);
      setFavorites(new Set(favs.card_ids));
      setLoading(false);
    });
  }, [deckId]);

  const advance = useCallback((nextIndex: number) => {
    setSlideDir(nextIndex >= prevIndexRef.current ? 'right' : 'left');
    prevIndexRef.current = nextIndex;
    setIndex(nextIndex);
    flipHook.resetCardState();
    setHintShown(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipHook.resetCardState]);

  const goNext = useCallback(() => {
    if (index < queue.length - 1) advance(index + 1);
    else setSessionDone(true);
  }, [index, queue.length, advance]);
  const goPrev = useCallback(() => { if (index > 0) advance(index - 1); }, [index, advance]);

  const starCard = (cardId: number) => {
    const wasFaved = favorites.has(cardId);
    setFavorites(prev => {
      const next = new Set(prev);
      wasFaved ? next.delete(cardId) : next.add(cardId);
      return next;
    });
    quizlet.toggleFavorite(deckId, cardId).catch(() => {
      setFavorites(prev => {
        const next = new Set(prev);
        wasFaved ? next.add(cardId) : next.delete(cardId);
        return next;
      });
    });
  };

  const toggleFavorite = (cardId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    starCard(cardId);
  };

  const toggleStudyStarred = (currentFavorites: Set<number>) => {
    setStudyStarredOnly(prev => {
      const next = !prev;
      const base = next
        ? (currentFavorites.size > 0 ? cards.filter(c => currentFavorites.has(c.id)) : cards)
        : cards;
      setQueue(isShuffled ? shuffle([...base]) : [...base]);
      setKnown(new Set()); setUnknown(new Set()); setHistory([]);
      setSessionDone(false);
      advance(0);
      return next;
    });
  };

  const markCard = (isKnown: boolean) => {
    if (!current || feedback) return;
    quizlet.review(deckId, current.id, isKnown ? 2 : 1);
    setStudiedToday(t => t + 1);
    setHistory(prev => [...prev, { cardId: current.id, wasKnown: isKnown }]);
    if (isKnown) {
      setKnown(prev => new Set([...prev, current.id]));
      setUnknown(prev => { const n = new Set(prev); n.delete(current.id); return n; });
    } else {
      setUnknown(prev => new Set([...prev, current.id]));
      setKnown(prev => { const n = new Set(prev); n.delete(current.id); return n; });
    }
    const isLast = index >= queue.length - 1;
    const capturedIndex = index;
    setFeedback(isKnown ? 'known' : 'unknown');
    setTimeout(() => {
      setFeedback(null);
      if (isLast) setSessionDone(true);
      else advance(capturedIndex + 1);
    }, 430);
  };

  const undoLast = () => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    if (last.wasKnown) setKnown(prev => { const n = new Set(prev); n.delete(last.cardId); return n; });
    else setUnknown(prev => { const n = new Set(prev); n.delete(last.cardId); return n; });
    if (index > 0) advance(index - 1);
  };

  const toggleShuffle = () => {
    setQueue(isShuffled ? [...cards] : shuffle([...cards]));
    setIsShuffled(s => !s);
    advance(0);
  };

  const toggleTrackProgress = () => {
    if (trackProgress) {
      trackProgressIndexRef.current = index;
      if (sessionDone) setSessionDone(false);
      setTrackProgress(false);
      setIsAutoplay(false);
      advance(0);
    } else {
      setTrackProgress(true);
      setIsAutoplay(false);
      advance(trackProgressIndexRef.current);
    }
  };

  const restart = (subset?: QuizletCard[]) => {
    const fullBase = studyStarredOnly && favorites.size > 0
      ? cards.filter(c => favorites.has(c.id))
      : cards;
    const base = subset ?? (isShuffled ? shuffle([...fullBase]) : [...fullBase]);
    setQueue(base);
    setKnown(new Set()); setUnknown(new Set()); setHistory([]);
    setSessionDone(false);
    advance(0);
  };

  useEffect(() => {
    if (expandedImage?.phase !== 'from') return;
    const t = setTimeout(() => {
      setExpandedImage(prev => prev ? { ...prev, phase: 'to' } : null);
    }, 16);
    return () => clearTimeout(t);
  }, [expandedImage?.phase]);

  useEffect(() => {
    if (!isAutoplay || trackProgress) return;
    autoplayRef.current = setTimeout(() => {
      if (flipHook.state === 'front') flipHook.flip();
      else if (index < queue.length - 1) advance(index + 1);
      else setIsAutoplay(false);
    }, 2000);
    return () => { if (autoplayRef.current) clearTimeout(autoplayRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutoplay, flipped, index, queue.length, trackProgress, advance]);

  // Dynamically update queue when starring/unstarring while studyStarredOnly is active
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!studyStarredOnly || cards.length === 0) return;
    const base = favorites.size > 0 ? cards.filter(c => favorites.has(c.id)) : cards;
    const newQueue = isShuffled ? shuffle([...base]) : [...base];
    setQueue(newQueue);
    setIndex(prev => Math.min(prev, Math.max(0, newQueue.length - 1)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites, studyStarredOnly]);

  const closeOptions = () => {
    setClosingOptions(true);
    setTimeout(() => { setShowOptions(false); setClosingOptions(false); }, 210);
  };

  const openEdit = useCallback((card: QuizletCard) => {
    setEditingCard(card);
  }, []);

  useEffect(() => {
    if (!editingCard) return;
    if (frontEditRef.current) frontEditRef.current.innerHTML = editingCard.front;
    if (backEditRef.current) backEditRef.current.innerHTML = editingCard.back;
    setEditImageUrl(editingCard.image ?? '');
    setTimeout(() => frontEditRef.current?.focus(), 50);
  }, [editingCard?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEditSave = async () => {
    if (!editingCard) return;
    const front = frontEditRef.current?.innerHTML ?? '';
    const back = backEditRef.current?.innerHTML ?? '';
    const image = editImageUrl.trim() || null;
    setEditSaving(true);
    try {
      await quizlet.updateCard(deckId, editingCard.id, front, back, image);
      const updated = { ...editingCard, front, back, image };
      setCards(prev => prev.map(c => c.id === editingCard.id ? updated : c));
      setQueue(prev => prev.map(c => c.id === editingCard.id ? updated : c));
      setEditingCard(null);
    } catch (err) {
      console.error('Failed to save card:', err);
    } finally {
      setEditSaving(false);
    }
  };

  const startLearn = useCallback((config: LearnConfig) => {
    const types = getQtypes(config);
    const stages = new Map<number, number>();
    cards.forEach(c => stages.set(c.id, 0));

    let initialQueue: LearnQItem[];
    if (config.goal === 'cram') {
      const shuffled = shuffle([...cards]);
      initialQueue = types.flatMap(qtype => shuffled.map(card => ({ card, qtype })));
    } else {
      initialQueue = shuffle([...cards]).map(card => ({ card, qtype: types[0] }));
    }

    setLearnConfig(config);
    setLearnStages(stages);
    setLearnMastered(new Set());
    setLearnFinalResult(new Map());
    setLearnQueue(initialQueue);
    setLearnQIdx(0);
    setLearnMCSelected(null);
    setLearnShowResult(false);
    setLearnWrittenText('');
    setLearnWrittenResult(null);
    setLearnNeedRetype(false);
    setLearnRetypeText('');
    setLearnFlipped(false);
    setLearnPhase('session');

    if (initialQueue[0]?.qtype === 'mc') {
      setLearnMCOptions(getMCOptions(initialQueue[0].card, cards));
    }
  }, [cards]);

  learnAdvanceRef.current = (wasCorrect: boolean) => {
    const item = learnQueue[learnQIdx];
    if (!item) return;

    const newFinalResult = new Map(learnFinalResult);
    newFinalResult.set(item.card.id, wasCorrect);
    setLearnFinalResult(newFinalResult);

    const types = getQtypes(learnConfig);
    const currentStage = learnStages.get(item.card.id) ?? 0;
    const newStages = new Map(learnStages);
    const newMastered = new Set(learnMastered);
    const newQueue = [...learnQueue];

    if (learnConfig.goal === 'memorize') {
      if (wasCorrect) {
        const nextStage = currentStage + 1;
        newStages.set(item.card.id, nextStage);
        if (nextStage >= types.length) {
          newMastered.add(item.card.id);
        } else {
          newQueue.push({ card: item.card, qtype: types[nextStage] });
        }
      } else {
        newQueue.push({ card: item.card, qtype: item.qtype });
      }
      setLearnStages(newStages);
      setLearnMastered(newMastered);
    }

    setLearnQueue(newQueue);

    const nextIdx = learnQIdx + 1;
    if (nextIdx >= newQueue.length) {
      setLearnPhase('end');
      return;
    }

    const nextItem = newQueue[nextIdx];
    setLearnQIdx(nextIdx);
    setLearnMCSelected(null);
    setLearnShowResult(false);
    setLearnWrittenText('');
    setLearnWrittenResult(null);
    setLearnNeedRetype(false);
    setLearnRetypeText('');
    setLearnFlipped(false);
    if (nextItem.qtype === 'mc') {
      setLearnMCOptions(getMCOptions(nextItem.card, cards));
    }
  };

  const learnAdvance = useCallback((wasCorrect: boolean) => {
    learnAdvanceRef.current(wasCorrect);
  }, []);

  // Keyboard shortcuts — ref keeps handler fresh without re-registering the listener
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (learnPhase !== 'off') return;
    if (showOptions) return;
    if (editingCard) {
      if (e.key === 'Escape') { setEditingCard(null); e.preventDefault(); }
      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    if (target.isContentEditable) return;
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); trackProgress ? markCard(true)  : goNext(); break;
      case 'ArrowLeft':  e.preventDefault(); trackProgress ? markCard(false) : goPrev(); break;
      case ' ':          e.preventDefault(); flipHook.flip(); break;
      case 's': case 'S': if (current) starCard(current.id); break;
      case 'h': case 'H': toggleShuffle(); break;
      case 'd': case 'D': setFrontSide('definition'); break;
      case 't': case 'T': setFrontSide('term'); break;
      case 'e': case 'E': if (current) openEdit(current); break;
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const progressPercent = queue.length > 0
    ? trackProgress
      ? Math.round(((known.size + unknown.size) / queue.length) * 100)
      : Math.round((index / queue.length) * 100)
    : 0;


  // Computed vars for inline learn rendering (used in main return below)
  const learnItem        = learnQueue[learnQIdx];
  const learnPrompt      = learnItem ? (learnConfig.answerWith === 'definition' ? learnItem.card.front : learnItem.card.back) : '';
  const learnCorrectHtml = learnItem ? (learnConfig.answerWith === 'definition' ? learnItem.card.back  : learnItem.card.front) : '';
  const learnPromptLabel = learnConfig.answerWith === 'definition' ? 'Term' : 'Definition';
  const learnEndMastered = [...learnFinalResult.values()].filter(Boolean).length;
  const learnEndLearning = [...learnFinalResult.values()].filter(v => !v).length;
  const learnEndPercent  = cards.length > 0 ? Math.round((learnEndMastered / cards.length) * 100) : 0;
  const learnEndMsg      = learnEndPercent === 100 ? 'Perfect! You know them all!'
    : learnEndPercent >= 80 ? 'Impressive! Just a bit more to go!'
    : learnEndPercent >= 60 ? 'Good progress! Keep it up!'
    : "Keep practicing — you're getting there!";
  const activeMode = learnPhase === 'off' ? 'flashcards' : 'learn';
  const handleModeClick = (id: string) => {
    if (id === 'flashcards') setLearnPhase('off');
    else if (id === 'learn') setLearnPhase('goal-pick');
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="skeleton h-8 w-48 rounded" />
        <div className="skeleton h-4 w-32 rounded" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-12 rounded-lg" />)}
        </div>
        <div className="skeleton h-80 rounded-xl" />
        <div className="skeleton h-8 w-full rounded" />
      </div>
    );
  }

  if (learnPhase === 'off' && sessionDone && trackProgress) {
    return (
      <EndScreen title={title} total={queue.length} known={known} unknown={unknown}
        onRestart={() => restart()} onBack={() => navigate('/')}
        onRestartUnknown={() => restart(cards.filter(c => unknown.has(c.id)))} />
    );
  }

  if (learnPhase === 'off' && sessionDone && !trackProgress) {
    return (
      <EndScreen title={title} total={queue.length}
        known={new Set<number>(queue.map(c => c.id))} unknown={new Set<number>()}
        onRestart={() => restart()} onBack={() => navigate('/')}
        onRestartUnknown={() => {}} />
    );
  }

  const isFaved = current ? favorites.has(current.id) : false;

  const generateHint = (text: string): string => {
    const words = text.trim().split(/\s+/);
    const n = words.length;
    if (n === 1) {
      const w = words[0];
      const show = Math.max(1, Math.ceil(w.length / 4));
      return w.slice(0, show) + '___';
    }
    const show = n <= 3 ? 1 : 2;
    return words.slice(0, show).join(' ') + ' ' + words.slice(show).map(() => '___').join(' ');
  };

  // Card face content — library handles backface-visibility and flip transform
  const renderFaceContent = (isBack: boolean) => {
    const swapped = frontSide === 'definition';
    const showingTerm = swapped ? isBack : !isBack;
    const text = showingTerm ? current?.front : current?.back;
    const hasImage = showingTerm && !!current?.image;
    const hintTarget = swapped ? (current?.front ?? '') : (current?.back ?? '');
    const backLabel = swapped ? 'Term' : 'Definition';
    return (
      <div className="flex flex-col h-full">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 pt-4 shrink-0">
          {!isBack ? (
            <button
              className={`flex items-start gap-1.5 text-xs transition-colors max-w-xs text-left ${hintShown ? 'text-(--accent)' : 'text-(--text-secondary) hover-accent'}`}
              onClick={e => { e.stopPropagation(); setHintShown(h => !h); }}
            >
              <Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {hintShown
                ? <span className="leading-snug">{generateHint(hintTarget)}</span>
                : 'Get a hint'}
            </button>
          ) : (
            <span className="text-xs text-(--text-secondary) uppercase tracking-wide">{backLabel}</span>
          )}
          <div className="flex items-center gap-1">
            <button className="p-1 transition-colors" onClick={e => { e.stopPropagation(); current && openEdit(current); }} title="Edit (E)">
              <Pencil className="w-4 h-4 text-(--text-secondary) hover:text-(--accent) transition-colors" />
            </button>
            <button className="p-1 transition-colors" onClick={e => current && toggleFavorite(current.id, e)} title="Favorite (S)">
              <Star className={`w-4 h-4 transition-colors ${isFaved ? 'fill-(--accent) text-(--accent)' : 'text-(--text-secondary) hover:text-(--accent)'}`} />
            </button>
          </div>
        </div>

        {/* Content */}
        {hasImage ? (
          <div className="flex-1 flex min-h-0">
            <div className="flex-1 flex items-center justify-center px-6 py-4 border-r border-(--bg-tertiary)">
              <div className="text-2xl font-medium leading-snug text-center" dangerouslySetInnerHTML={{ __html: text ?? '' }} />
            </div>
            <div className="flex-1 p-4">
              <img src={current!.image!} alt="" className="w-full h-full object-contain rounded-lg" />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 py-4 min-h-0">
            <div className="text-2xl font-medium leading-snug text-center w-full" dangerouslySetInnerHTML={{ __html: text ?? '' }} />
          </div>
        )}

        <div className="pb-4 shrink-0" />
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4 pb-8">
      <button onClick={() => navigate('/')} className="flex items-center gap-2 text-(--text-secondary) hover-accent text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Decks
      </button>

      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <div className="flex items-center gap-5 mt-1 text-sm text-(--text-secondary)">
          <span className="flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-(--accent)" />{studiedToday} studied today</span>
          <span className="flex items-center gap-1.5"><Star className="w-3.5 h-3.5 fill-(--accent) text-(--accent)" />{favorites.size} favorited</span>
        </div>
      </div>

      {/* Desktop mode grid */}
      <div className="hidden sm:block">
        <ModeGrid activeMode={activeMode} onModeClick={handleModeClick} />
      </div>

      {/* ── FLASHCARD mode ── */}
      {learnPhase === 'off' && (<>
        {/* Card with 3D flip + slide-in */}
        <div style={{ perspective: '1100px' }}>
          <div
            key={index}
            className={`relative ${
              feedback
                ? (feedback === 'unknown' ? 'card-swipe-left' : 'card-swipe-right')
                : (slideDir === 'right' ? 'card-slide-right' : 'card-slide-left')
            }`}
          >
            {feedback && (
              <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                <span className={`text-4xl font-bold ${feedback === 'unknown' ? 'text-orange-400' : 'text-green-400'}`}>
                  {feedback === 'unknown' ? 'Still learning' : 'Got it!'}
                </span>
              </div>
            )}
            <Flashcard
              flipHook={flipHook}
              front={{ html: renderFaceContent(false) }}
              back={{ html: renderFaceContent(true) }}
              style={{ height: 'clamp(16rem, 72vw, 28rem)' }}
            />
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2">
          <div className="w-8 shrink-0">
            {trackProgress && (
              <button className={`icon-btn ${history.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
                onClick={undoLast} disabled={history.length === 0} title="Undo">
                <Undo2 className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              className={`w-12 h-12 sm:w-10 sm:h-10 rounded-full flex items-center justify-center transition-colors ${
                trackProgress ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-30'
                  : 'bg-(--bg-secondary) text-(--text-secondary) hover-accent disabled:opacity-30'
              }`}
              onClick={() => trackProgress ? markCard(false) : goPrev()}
              disabled={(!trackProgress && index === 0) || !!feedback}
            >
              {trackProgress ? <X className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
            </button>
            <span className="text-sm text-(--text-secondary) text-center tabular-nums whitespace-nowrap">{index + 1} / {queue.length}</span>
            <button
              className={`w-12 h-12 sm:w-10 sm:h-10 rounded-full flex items-center justify-center transition-colors ${
                trackProgress ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-30'
                  : 'bg-(--bg-secondary) text-(--text-secondary) hover-accent disabled:opacity-30'
              }`}
              onClick={() => trackProgress ? markCard(true) : goNext()}
              disabled={!!feedback}
            >
              {trackProgress ? <Check className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
            </button>
          </div>

          <button className="icon-btn shrink-0" title="Options" onClick={() => setShowOptions(true)}>
            <Settings className="w-4 h-4" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-(--bg-tertiary) rounded-full h-1 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%`, background: 'var(--accent)' }} />
        </div>
      </>)}

      {/* ── GOAL PICK ── */}
      {learnPhase === 'goal-pick' && (
        <div className="card max-w-lg mx-auto text-center space-y-6 py-8">
          <div>
            <h2 className="text-xl font-bold mb-1">Choose a goal for this session</h2>
            <p className="text-sm text-(--text-secondary)">This will shape how your session works.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-left">
            {([
              { g: 'cram' as const, title: 'Cram for a test', desc: 'Go through each term once — best for quick review.' },
              { g: 'memorize' as const, title: 'Memorize it all', desc: 'Repeat cards until all are mastered — best for retention.' },
            ]).map(({ g, title: t, desc }) => (
              <button key={g}
                onClick={() => startLearn({ ...learnConfig, goal: g })}
                className="rounded-xl p-4 bg-(--bg-tertiary) hover:bg-(--accent)/10 hover:text-(--accent) transition-colors text-left">
                <p className="font-semibold text-sm mb-1">{t}</p>
                <p className="text-xs text-(--text-secondary)">{desc}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── LEARN SESSION ── */}
      {learnPhase === 'session' && learnItem && (
        <div className="space-y-4">
          {/* Gear for learn settings */}
          <div className="flex justify-end">
            <button onClick={() => setShowLearnOptions(true)} className="icon-btn" title="Learn settings">
              <Settings className="w-4 h-4" />
            </button>
          </div>

          {/* Segmented progress bar */}
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-(--text-secondary) shrink-0">{learnQIdx}</span>
            <div className="flex-1 flex gap-0.5 h-2">
              {Array.from({ length: Math.min(learnQueue.length, 60) }).map((_, i) => {
                const segIdx = Math.floor((i / Math.min(learnQueue.length, 60)) * learnQueue.length);
                return (
                  <div key={i} className="flex-1 rounded-full transition-colors duration-300"
                    style={{ background: segIdx < learnQIdx ? 'var(--accent)' : 'var(--bg-tertiary)' }} />
                );
              })}
            </div>
            <span className="text-xs tabular-nums text-(--text-secondary) shrink-0">{learnQueue.length}</span>
          </div>

          {/* Prompt card */}
          <div className="card flex flex-col" style={{ minHeight: 'clamp(12rem, 50vw, 22rem)' }}>
            <div className="px-5 pt-4 shrink-0">
              <span className="text-xs text-(--text-secondary) uppercase tracking-wide">{learnPromptLabel}</span>
            </div>
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <div className="text-2xl font-medium leading-snug" dangerouslySetInnerHTML={{ __html: learnPrompt }} />
            </div>
          </div>

          {/* Multiple choice */}
          {learnItem.qtype === 'mc' && (
            <div className="space-y-3">
              <p className="text-sm text-(--text-secondary) font-medium">Choose an answer</p>
              <div className="grid grid-cols-2 gap-2">
                {learnMCOptions.map((opt, i) => {
                  const optHtml   = learnConfig.answerWith === 'definition' ? opt.back : opt.front;
                  const isCorrect = opt.id === learnItem.card.id;
                  const isSelected = learnMCSelected === opt.id;
                  let cls = 'card text-left p-4 w-full text-sm font-medium transition-colors flex items-start gap-3';
                  if (learnShowResult) {
                    if (isCorrect)       cls += ' !border-green-500 bg-green-500/10';
                    else if (isSelected) cls += ' !border-red-500 bg-red-500/10';
                    else                 cls += ' opacity-40';
                  }
                  return (
                    <button key={opt.id} disabled={learnShowResult} className={cls}
                      onClick={() => {
                        if (learnShowResult) return;
                        setLearnMCSelected(opt.id);
                        setLearnShowResult(true);
                        setTimeout(() => learnAdvance(isCorrect), isCorrect ? 700 : 1300);
                      }}
                    >
                      <span className="shrink-0 w-6 h-6 rounded-md bg-(--bg-tertiary) flex items-center justify-center text-xs font-bold text-(--text-secondary)">{i + 1}</span>
                      <div dangerouslySetInnerHTML={{ __html: optHtml }} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Written */}
          {learnItem.qtype === 'written' && !learnNeedRetype && (
            <div className="space-y-3">
              <input
                ref={learnWrittenRef}
                type="text"
                placeholder="Type your answer…"
                value={learnWrittenText}
                onChange={e => setLearnWrittenText(e.target.value)}
                disabled={!!learnWrittenResult}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && !learnWrittenResult) {
                    const ok = gradeAnswer(learnWrittenText, learnCorrectHtml, learnConfig.grading);
                    setLearnWrittenResult(ok ? 'correct' : 'wrong');
                  }
                }}
                className={`input w-full text-base py-3 ${learnWrittenResult === 'correct' ? 'border-green-500' : learnWrittenResult === 'wrong' ? 'border-red-500' : ''}`}
              />
              {learnWrittenResult && (
                <div className={`rounded-lg p-3 text-sm ${learnWrittenResult === 'correct' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                  {learnWrittenResult === 'correct'
                    ? <div className="flex items-center gap-2"><Check className="w-4 h-4" /> Correct!</div>
                    : <div>
                        <div className="flex items-center gap-2 mb-1"><X className="w-4 h-4" /> Incorrect</div>
                        <p className="text-white/80">Correct answer: <span className="font-semibold" dangerouslySetInnerHTML={{ __html: learnCorrectHtml }} /></p>
                      </div>
                  }
                </div>
              )}
              {!learnWrittenResult
                ? <button onClick={() => { const ok = gradeAnswer(learnWrittenText, learnCorrectHtml, learnConfig.grading); setLearnWrittenResult(ok ? 'correct' : 'wrong'); }} className="btn btn-primary w-full">Check Answer</button>
                : <button onClick={() => {
                    const wasCorrect = learnWrittenResult === 'correct';
                    if (!wasCorrect && learnConfig.retypeWrong) { setLearnNeedRetype(true); setLearnRetypeText(''); }
                    else learnAdvance(wasCorrect);
                  }} className="btn btn-secondary w-full">Continue</button>
              }
            </div>
          )}

          {/* Written retype gate */}
          {learnItem.qtype === 'written' && learnNeedRetype && (
            <div className="space-y-3">
              <p className="text-sm text-(--text-secondary)">Type the correct answer to continue:</p>
              <input type="text" placeholder="Retype the correct answer…" value={learnRetypeText}
                onChange={e => setLearnRetypeText(e.target.value)} autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && gradeAnswer(learnRetypeText, learnCorrectHtml, 'moderate')) { setLearnNeedRetype(false); learnAdvance(false); } }}
                className="input w-full text-base py-3" />
              <button onClick={() => { if (gradeAnswer(learnRetypeText, learnCorrectHtml, 'moderate')) { setLearnNeedRetype(false); learnAdvance(false); } }} className="btn btn-primary w-full">Submit</button>
            </div>
          )}

          {/* Flashcard confirmation */}
          {learnItem.qtype === 'flashcard' && (
            <div className="space-y-3">
              <div className="card cursor-pointer flex flex-col items-center justify-center text-center p-6 select-none"
                style={{ minHeight: 'clamp(10rem, 40vw, 18rem)' }}
                onClick={() => setLearnFlipped(f => !f)}>
                {!learnFlipped
                  ? <div className="space-y-2">
                      <div className="text-2xl font-medium leading-snug" dangerouslySetInnerHTML={{ __html: learnPrompt }} />
                      <p className="text-xs text-(--text-secondary) mt-3">Tap to reveal answer</p>
                    </div>
                  : <div className="text-2xl font-medium leading-snug" dangerouslySetInnerHTML={{ __html: learnCorrectHtml }} />
                }
              </div>
              {learnFlipped && (
                <div className="flex gap-2">
                  <button onClick={() => { setLearnFlipped(false); learnAdvance(false); }}
                    className="flex-1 py-3 rounded-lg bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 font-medium text-sm flex items-center justify-center gap-2 transition-colors">
                    <X className="w-4 h-4" /> Still learning
                  </button>
                  <button onClick={() => { setLearnFlipped(false); learnAdvance(true); }}
                    className="flex-1 btn btn-primary flex items-center justify-center gap-2">
                    <Check className="w-4 h-4" /> Got it
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── LEARN END ── */}
      {learnPhase === 'end' && (
        <div className="card">
          <h2 className="text-2xl font-bold mb-6">{learnEndMsg}</h2>
          <div className="flex flex-col sm:flex-row gap-8">
            <div className="flex-1">
              <p className="text-sm text-(--text-secondary) font-medium mb-4">How you're doing</p>
              <div className="flex items-center gap-6">
                <DonutChart percent={learnEndPercent} />
                <div className="space-y-2 flex-1">
                  {[
                    { label: 'Correct',        count: learnEndMastered, color: 'bg-green-500' },
                    { label: 'Still learning', count: learnEndLearning, color: 'bg-orange-500' },
                  ].map(({ label, count, color }) => (
                    <div key={label}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="flex items-center gap-2"><span className={`w-3 h-3 rounded-sm inline-block ${color}`} />{label}</span>
                        <span className="font-semibold">{count}</span>
                      </div>
                      <div className="w-full bg-(--bg-tertiary) rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full transition-all ${color}`} style={{ width: `${cards.length > 0 ? (count / cards.length) * 100 : 0}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex-1">
              <p className="text-sm text-(--text-secondary) font-medium mb-4">Next steps</p>
              <div className="space-y-3">
                <button onClick={() => setLearnPhase('session')} className="btn btn-primary w-full flex items-center justify-center gap-2">
                  <RotateCcw className="w-4 h-4" /> Study again
                </button>
                <button onClick={() => setLearnPhase('goal-pick')} className="btn btn-secondary w-full">Change settings</button>
                <button onClick={() => setLearnPhase('off')} className="text-sm text-(--accent) hover-underline w-full text-center">Back to Flashcards</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mobile mode grid */}
      <div className="block sm:hidden">
        <ModeGrid mobile activeMode={activeMode} onModeClick={handleModeClick} />
      </div>

      {/* Card list */}
      {(() => {
        let filtered = cards;
        if (listFilter === 'favorites') filtered = filtered.filter(c => favorites.has(c.id));
        else if (listFilter === 'learning') filtered = filtered.filter(c => unknown.has(c.id));
        else if (listFilter === 'mastered') filtered = filtered.filter(c => known.has(c.id));
        if (listFilter === 'alpha') filtered = [...filtered].sort((a, b) => a.front.localeCompare(b.front));
        if (listSearch.trim()) {
          const q = listSearch.toLowerCase();
          filtered = filtered.filter(c => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
        }
        return (
          <div className="space-y-3 pt-4">
            {/* Title row: big title left, filter count right */}
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-xl font-bold">Terms in this set ({cards.length})</h2>
              {listFilter === 'learning' ? (
                <span className="text-sm font-semibold text-orange-400 shrink-0">{unknown.size} still learning</span>
              ) : listFilter === 'mastered' ? (
                <span className="text-sm font-semibold text-green-400 shrink-0">{known.size} mastered</span>
              ) : listFilter === 'favorites' ? (
                <span className="text-sm font-semibold text-(--accent) shrink-0">{favorites.size} favorited</span>
              ) : listFilter === 'alpha' ? (
                <span className="text-sm font-semibold text-white/60 shrink-0">{filtered.length} terms</span>
              ) : (
                <span className="text-sm font-semibold text-white/60 shrink-0">{filtered.length} terms</span>
              )}
            </div>

            {/* Search + filter row */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Search terms..."
                value={listSearch}
                onChange={e => setListSearch(e.target.value)}
                className="input flex-1"
              />
              <select
                value={listFilter}
                onChange={e => setListFilter(e.target.value as typeof listFilter)}
                className="input shrink-0 cursor-pointer"
              >
                <option value="all">All</option>
                <option value="favorites">Favorites</option>
                <option value="learning">Still learning</option>
                <option value="mastered">Mastered</option>
                <option value="alpha">Alphabetical</option>
              </select>
            </div>

            {/* Card rows */}
            <div className="space-y-2">
              {filtered.length === 0 ? (
                <p className="text-sm text-(--text-secondary) text-center py-6">No terms match.</p>
              ) : filtered.map(card => {
                const isFavedCard = favorites.has(card.id);
                const isKnownCard = known.has(card.id);
                const isUnknownCard = unknown.has(card.id);
                return (
                  <div
                    key={card.id}
                    className="relative bg-(--bg-secondary) rounded-xl overflow-hidden"
                  >
                    {/* Edit + Star top-right */}
                    <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5">
                      <button onClick={e => { e.stopPropagation(); openEdit(card); }} className="p-1" title="Edit">
                        <Pencil className="w-3.5 h-3.5 text-(--text-secondary) hover:text-(--accent) transition-colors" />
                      </button>
                      <button onClick={e => toggleFavorite(card.id, e)} className="p-1">
                        <Star className={`w-3.5 h-3.5 transition-colors ${isFavedCard ? 'fill-(--accent) text-(--accent)' : 'text-(--text-secondary) hover:text-(--accent)'}`} />
                      </button>
                    </div>

                    {/* Two-half split */}
                    <div className="flex" style={{ minHeight: '88px' }}>
                      {/* Left: TERM */}
                      <div className="flex-1 flex flex-col p-3 border-r border-(--bg-tertiary)">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-secondary) mb-1.5">Term</span>
                        <div className="text-sm font-medium leading-snug flex-1 flex items-center" dangerouslySetInnerHTML={{ __html: card.front }} />
                      </div>
                      {/* Right: DEFINITION + image */}
                      <div className="flex-1 flex flex-col p-3 pr-12">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-secondary)">Definition</span>
                          {isKnownCard && <span className="text-[10px] font-semibold text-green-400 ml-auto">Mastered</span>}
                          {isUnknownCard && <span className="text-[10px] font-semibold text-orange-400 ml-auto">Learning</span>}
                        </div>
                        <div className="flex-1 flex gap-2 min-h-0 items-center">
                          <div className="text-sm leading-snug flex-1" dangerouslySetInnerHTML={{ __html: card.back }} />
                          {card.image && (
                            <img
                              src={card.image} alt=""
                              className="shrink-0 rounded object-contain cursor-zoom-in hover:opacity-85 transition-opacity"
                              style={{ width: '56px', height: '56px' }}
                              onClick={e => {
                                e.stopPropagation();
                                const r = e.currentTarget.getBoundingClientRect();
                                setExpandedImage({ src: card.image!, fromRect: { top: r.top, left: r.left, width: r.width, height: r.height }, phase: 'from' });
                              }}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Options panel */}
      {showOptions && (
        <div className="fixed inset-0 z-[100] flex justify-end items-stretch bg-black/50" onClick={closeOptions}>
          <div
            className={`${closingOptions ? 'options-panel-closing' : 'options-panel'} bg-(--bg-secondary) border-l border-(--bg-tertiary) w-full max-w-sm self-stretch overflow-y-auto shadow-2xl flex flex-col divide-y divide-white/8`}
            style={{ minHeight: '100%' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 shrink-0" style={{ paddingTop: 'calc(1.5rem + env(safe-area-inset-top, 0px))' }}>
              <h2 className="text-xl font-bold">Options</h2>
              <button className="icon-btn" onClick={closeOptions} title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Track progress */}
            <div className="p-6 flex items-center justify-between gap-4">
              <div>
                <p className="font-medium text-sm">Track progress</p>
                <p className="text-xs text-(--text-secondary) mt-0.5">Mark cards as known or still learning. Turns nav buttons into ✓ / ✗.</p>
              </div>
              <button onClick={toggleTrackProgress} className="shrink-0">
                <div className={`relative w-9 h-5 rounded-full transition-colors ${trackProgress ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${trackProgress ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
              </button>
            </div>

            {/* Shuffle */}
            <div className="p-6 flex items-center justify-between gap-4">
              <p className="font-medium text-sm">Shuffle</p>
              <button onClick={() => { toggleShuffle(); }} className="shrink-0">
                <div className={`relative w-9 h-5 rounded-full transition-colors ${isShuffled ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isShuffled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
              </button>
            </div>

            {/* Autoplay */}
            {!trackProgress && (
              <div className="p-6 flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-sm">Autoplay</p>
                  <p className="text-xs text-(--text-secondary) mt-0.5">Automatically flip and advance every 2 seconds.</p>
                </div>
                <button onClick={() => setIsAutoplay(a => !a)} className="shrink-0">
                  <div className={`relative w-9 h-5 rounded-full transition-colors ${isAutoplay ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isAutoplay ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                </button>
              </div>
            )}

            {/* Study only starred terms */}
            <div className="p-6 flex items-center justify-between gap-4">
              <div>
                <p className={`font-medium text-sm ${favorites.size === 0 ? 'text-(--text-secondary)' : ''}`}>Study only starred terms</p>
                {favorites.size === 0 && <p className="text-xs text-(--text-secondary) mt-0.5">Star some cards first.</p>}
              </div>
              <button
                onClick={() => favorites.size > 0 && toggleStudyStarred(favorites)}
                disabled={favorites.size === 0}
                className={`shrink-0 ${favorites.size === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className={`relative w-9 h-5 rounded-full transition-colors ${studyStarredOnly ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${studyStarredOnly ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
              </button>
            </div>

            {/* Front */}
            <div className="p-6 flex items-center justify-between gap-4">
              <p className="font-medium text-sm">Front</p>
              <select
                value={frontSide}
                onChange={e => { setFrontSide(e.target.value as 'term' | 'definition'); flipHook.resetCardState(); }}
                className="input text-sm py-1.5 cursor-pointer"
              >
                <option value="term">Term</option>
                <option value="definition">Definition</option>
              </select>
            </div>

            {/* Keyboard shortcuts */}
            <div>
              <button
                className="w-full flex items-center justify-between p-6"
                onClick={() => setShowShortcuts(s => !s)}
              >
                <p className="font-medium text-sm">Keyboard shortcuts</p>
                <ChevronDown className={`w-4 h-4 text-(--text-secondary) transition-transform ${showShortcuts ? 'rotate-180' : ''}`} />
              </button>
              {showShortcuts && (
                <div className="px-6 pb-6 space-y-3">
                  {([
                    ['→',    'Know / Next'],
                    ['←',    'Still learning / Prev'],
                    ['Space','Flip card'],
                    ['S',    'Star card'],
                    ['H',    'Shuffle'],
                    ['T',    'Answer with term'],
                    ['D',    'Answer with definition'],
                    ['E',    'Edit card'],
                  ] as [string, string][]).map(([key, label]) => (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-sm text-(--text-secondary)">{label}</span>
                      <kbd className="px-2 py-0.5 rounded bg-(--bg-tertiary) text-white font-mono text-xs">{key}</kbd>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Restart */}
            <div className="p-6" style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}>
              <button
                className="text-sm text-(--accent) font-medium hover-underline"
                onClick={() => { restart(); closeOptions(); }}
              >
                Restart Flashcards
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Learn settings panel */}
      {showLearnOptions && (
        <div className="fixed inset-0 z-[100] flex justify-end items-stretch bg-black/50" onClick={() => setShowLearnOptions(false)}>
          <div className="options-panel bg-(--bg-secondary) border-l border-(--bg-tertiary) w-full max-w-sm self-stretch overflow-y-auto shadow-2xl flex flex-col divide-y divide-white/8"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-6 shrink-0" style={{ paddingTop: 'calc(1.5rem + env(safe-area-inset-top, 0px))' }}>
              <h2 className="text-xl font-bold">Learn Settings</h2>
              <button className="icon-btn" onClick={() => setShowLearnOptions(false)}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 flex items-center justify-between gap-4">
              <p className="font-medium text-sm">Answer with</p>
              <select value={learnConfig.answerWith} onChange={e => setLearnConfig(prev => ({ ...prev, answerWith: e.target.value as 'term' | 'definition' }))} className="input text-sm py-1.5 cursor-pointer">
                <option value="definition">Definition</option>
                <option value="term">Term</option>
              </select>
            </div>
            <div className="p-6 space-y-3">
              <p className="font-medium text-sm">Question types</p>
              {([{ key: 'mc' as const, label: 'Multiple choice' }, { key: 'written' as const, label: 'Written' }]).map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-sm text-(--text-secondary)">{label}</span>
                  <button onClick={() => setLearnConfig(prev => ({ ...prev, [key]: !prev[key] }))}
                    className={`relative w-9 h-5 rounded-full transition-colors ${learnConfig[key] ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${learnConfig[key] ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              ))}
              <p className="text-xs text-(--text-secondary)">Flashcards always included as final stage.</p>
            </div>
            <div className="p-6 flex items-center justify-between gap-4">
              <p className="font-medium text-sm">Grading</p>
              <select value={learnConfig.grading} onChange={e => setLearnConfig(prev => ({ ...prev, grading: e.target.value as 'relaxed' | 'moderate' | 'strict' }))} className="input text-sm py-1.5 cursor-pointer">
                <option value="relaxed">Relaxed</option>
                <option value="moderate">Moderate</option>
                <option value="strict">Strict</option>
              </select>
            </div>
            {learnConfig.written && (
              <div className="p-6 flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-sm">Retype correct answers</p>
                  <p className="text-xs text-(--text-secondary) mt-0.5">Type correct answer after getting written wrong.</p>
                </div>
                <button onClick={() => setLearnConfig(prev => ({ ...prev, retypeWrong: !prev.retypeWrong }))} className="shrink-0">
                  <div className={`relative w-9 h-5 rounded-full transition-colors ${learnConfig.retypeWrong ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${learnConfig.retypeWrong ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                </button>
              </div>
            )}
            <div className="p-6" style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}>
              <button className="text-sm text-(--accent) font-medium hover-underline"
                onClick={() => { setShowLearnOptions(false); setShowRestartLearnConfirm(true); }}>
                Restart Learn
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restart Learn confirm */}
      {showRestartLearnConfirm && (
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowRestartLearnConfirm(false)}>
          <div className="bg-(--bg-secondary) rounded-xl max-w-md w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Restart Learn?</h3>
            <p className="text-sm text-(--text-secondary)">Restarting will reset your study goal and progress — you'll see all the same terms, starting from the beginning.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowRestartLearnConfirm(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={() => { setShowRestartLearnConfirm(false); setLearnPhase('goal-pick'); }} className="btn btn-primary">Restart</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Card Modal */}
      {editingCard && (
        <div className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center p-4" onClick={() => setEditingCard(null)}>
          <div className="bg-(--bg-secondary) rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg">Edit Card</h3>
                <button onClick={() => setEditingCard(null)} className="icon-btn"><X className="w-4 h-4" /></button>
              </div>

              {/* Term */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-(--text-secondary) mb-1.5">Term</label>
                <FormatToolbar />
                <div
                  ref={frontEditRef}
                  contentEditable
                  suppressContentEditableWarning
                  className="w-full min-h-[80px] rounded-lg p-3 bg-(--bg-tertiary) border border-(--bg-tertiary) focus:border-(--accent) focus:outline-none text-sm leading-relaxed"
                  style={{ transition: 'border-color 0.15s' }}
                />
              </div>

              {/* Definition */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-(--text-secondary) mb-1.5">Definition</label>
                <FormatToolbar />
                <div
                  ref={backEditRef}
                  contentEditable
                  suppressContentEditableWarning
                  className="w-full min-h-[80px] rounded-lg p-3 bg-(--bg-tertiary) border border-(--bg-tertiary) focus:border-(--accent) focus:outline-none text-sm leading-relaxed"
                  style={{ transition: 'border-color 0.15s' }}
                />
              </div>

              {/* Image */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-(--text-secondary) mb-1.5">Image</label>
                {editImageUrl && (
                  <div className="flex items-center gap-3 mb-2 p-2 bg-(--bg-tertiary) rounded-lg">
                    <img src={editImageUrl} alt="" className="w-14 h-14 object-contain rounded shrink-0" onError={e => (e.currentTarget.style.display = 'none')} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-(--text-secondary) truncate">{editImageUrl}</p>
                    </div>
                    <button onClick={() => setEditImageUrl('')} className="icon-btn icon-btn-danger shrink-0"><X className="w-3.5 h-3.5" /></button>
                  </div>
                )}
                <input
                  type="url"
                  placeholder="Image URL (leave empty for no image)"
                  value={editImageUrl}
                  onChange={e => setEditImageUrl(e.target.value)}
                  className="input w-full text-sm"
                />
              </div>

              {/* Actions */}
              <div className="flex gap-2 justify-end pt-2">
                <button onClick={() => setEditingCard(null)} className="btn btn-secondary" disabled={editSaving}>Cancel</button>
                <button onClick={handleEditSave} className="btn btn-primary" disabled={editSaving}>
                  {editSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Expanded image overlay */}
      {expandedImage && (() => {
        const { src, fromRect, phase } = expandedImage;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const expandW = Math.min(vw * 0.82, 640);
        const expandH = Math.min(vh * 0.65, 520);
        const toStyle: React.CSSProperties = {
          top: Math.max((vh - expandH) / 2, 16),
          left: Math.max((vw - expandW) / 2, 16),
          width: expandW,
          height: expandH,
          opacity: 1,
          borderRadius: '0.75rem',
        };
        const fromStyle: React.CSSProperties = {
          top: fromRect.top,
          left: fromRect.left,
          width: fromRect.width,
          height: fromRect.height,
          opacity: phase === 'closing' ? 0 : 1,
          borderRadius: '0.25rem',
        };
        return (
          <div
            className="fixed inset-0 z-50"
            style={{
              background: phase === 'to' ? 'rgba(0,0,0,0.38)' : 'transparent',
              transition: 'background 0.38s ease',
            }}
            onClick={() => setExpandedImage(prev => prev ? { ...prev, phase: 'closing' } : null)}
          >
            <img
              src={src}
              alt=""
              onClick={() => setExpandedImage(prev => prev ? { ...prev, phase: 'closing' } : null)}
              style={{
                position: 'fixed',
                objectFit: 'contain',
                cursor: 'zoom-out',
                transition: 'top 0.4s cubic-bezier(0.22,1,0.36,1), left 0.4s cubic-bezier(0.22,1,0.36,1), width 0.4s cubic-bezier(0.22,1,0.36,1), height 0.4s cubic-bezier(0.22,1,0.36,1), opacity 0.36s ease, border-radius 0.4s ease',
                zIndex: 60,
                ...(phase === 'to' ? toStyle : fromStyle),
              }}
              onTransitionEnd={e => {
                if (e.propertyName === 'opacity' && expandedImage.phase === 'closing') {
                  setExpandedImage(null);
                }
              }}
            />
          </div>
        );
      })()}

      <style>{`
        /* Options panel slide in / out */
        @keyframes panelSlideIn  { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes panelSlideOut { from { transform: translateX(0); }    to { transform: translateX(100%); } }
        .options-panel         { animation: panelSlideIn  0.38s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .options-panel-closing { animation: panelSlideOut 0.2s  cubic-bezier(0.4,  0, 0.6, 1) forwards; }

        /* Override library defaults for dark theme */
        .flashcard-wrapper {
          width: 100% !important;
          height: clamp(16rem, 72vw, 28rem) !important;
          bottom: auto !important;
          --front-bg: var(--bg-secondary);
          --back-bg: var(--bg-secondary);
          --box-shadow: none;
          --border-radius: 0.75rem;
        }
        .flashcard__front, .flashcard__back {
          color: inherit !important;
        }

        /* Card slide-in animations */
        @keyframes cardSlideForward {
          from { opacity: 0; transform: translateX(60px) rotateY(-12deg) scale(0.96); }
          to   { opacity: 1; transform: translateX(0) rotateY(0deg) scale(1); }
        }
        @keyframes cardSlideBack {
          from { opacity: 0; transform: translateX(-60px) rotateY(12deg) scale(0.96); }
          to   { opacity: 1; transform: translateX(0) rotateY(0deg) scale(1); }
        }
        .card-slide-right { animation: cardSlideForward 0.38s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .card-slide-left  { animation: cardSlideBack    0.38s cubic-bezier(0.22, 1, 0.36, 1) forwards; }

        /* Mark card swipe-away animations */
        @keyframes swipeLeft {
          0%   { transform: translateX(0)     rotateZ(0deg);   opacity: 1; }
          20%  { transform: translateX(-18px) rotateZ(5deg);   opacity: 1; }
          65%  { opacity: 0.5; }
          100% { transform: translateX(-145%) rotateZ(22deg);  opacity: 0; }
        }
        @keyframes swipeRight {
          0%   { transform: translateX(0)    rotateZ(0deg);    opacity: 1; }
          20%  { transform: translateX(18px) rotateZ(-5deg);   opacity: 1; }
          65%  { opacity: 0.5; }
          100% { transform: translateX(145%) rotateZ(-22deg);  opacity: 0; }
        }
        .card-swipe-left  { animation: swipeLeft  0.43s cubic-bezier(0.4, 0, 0.9, 0.6) forwards; }
        .card-swipe-right { animation: swipeRight 0.43s cubic-bezier(0.4, 0, 0.9, 0.6) forwards; }
      `}</style>
    </div>
  );
}
