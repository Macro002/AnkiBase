import { useState, useEffect, useRef, useCallback } from 'react';
import confetti from 'canvas-confetti';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Star, ChevronLeft, ChevronRight, ChevronDown,
  Play, Undo2, Shuffle, Settings, Maximize2, X, Check,
  TrendingUp, Lightbulb, BookOpen,
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

const MODES = [
  { id: 'flashcards', label: 'Flashcards', Icon: FlashcardsIcon, active: true  },
  { id: 'learn',      label: 'Learn',      Icon: LearnIcon,      active: false },
  { id: 'test',       label: 'Test',       Icon: TestIcon,       active: false },
  { id: 'blocks',     label: 'Blocks',     Icon: BlocksIcon,     active: false },
  { id: 'blast',      label: 'Blast',      Icon: BlastIcon,      active: false },
  { id: 'match',      label: 'Match',      Icon: MatchIcon,      active: false },
];

// desktop: 3-col grid, icon left + label right
// mobile: rendered separately below progress bar as 2-col grid, icon+label stacked
function ModeGrid({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={mobile
      ? 'grid grid-cols-2 gap-2'
      : 'grid grid-cols-3 gap-2'
    }>
      {MODES.map(({ id, label, Icon, active }) => (
        <button
          key={id}
          disabled={!active}
          title={active ? undefined : 'Coming soon'}
          className={`rounded-lg font-medium transition-colors ${
            mobile
              ? 'flex flex-col items-center justify-center gap-1.5 py-4 px-2 text-xs'
              : 'flex items-center gap-3 px-4 py-3 text-sm'
          } ${
            active
              ? 'bg-(--accent)/10 text-(--accent)'
              : 'bg-(--bg-secondary) text-(--text-secondary) opacity-40 cursor-not-allowed'
          }`}
        >
          <Icon
            className={mobile ? 'w-8 h-8' : 'w-6 h-6'}
            style={{ color: 'rgba(var(--accent-rgb), 0.55)' }}
          />
          {label}
        </button>
      ))}
    </div>
  );
}

interface EndScreenProps {
  title: string; total: number; known: Set<number>; unknown: Set<number>;
  onRestart: () => void; onRestartUnknown: () => void; onBack: () => void;
}

function EndScreen({ title, total, known, unknown, onRestart, onRestartUnknown, onBack }: EndScreenProps) {
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
      <div className="card">
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
  );
}

function SimpleEndScreen({ title, total, onRestart, onBackToLast, onBack }: {
  title: string; total: number;
  onRestart: () => void; onBackToLast: () => void; onBack: () => void;
}) {
  useEffect(() => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const hover  = getComputedStyle(document.documentElement).getPropertyValue('--accent-hover').trim();
    const colors = [accent, hover, '#ffffff'];
    confetti({ particleCount: 100, spread: 70, origin: { x: 0.5, y: 0.55 }, colors });
    setTimeout(() => confetti({ particleCount: 55, spread: 90, origin: { x: 0.2, y: 0.5 }, colors }), 320);
    setTimeout(() => confetti({ particleCount: 55, spread: 90, origin: { x: 0.8, y: 0.5 }, colors }), 550);
  }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-8">
      <button onClick={onBack} className="flex items-center gap-2 text-(--text-secondary) hover-accent text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Decks
      </button>
      <h1 className="text-2xl font-bold">{title}</h1>
      <ModeGrid />
      <div className="card relative overflow-hidden">
        <div className="absolute top-3 right-4 text-5xl leading-none select-none pointer-events-none" style={{ filter: 'drop-shadow(0 2px 12px rgba(0,0,0,0.5))' }}>
          🎉
        </div>
        <h2 className="text-2xl font-bold mb-2">Way to go!</h2>
        <p className="text-(--text-secondary) mb-6">You've reviewed all {total} cards.</p>
        <div className="flex gap-8 mb-6">
          <div>
            <div className="text-3xl font-bold text-(--accent)">{total}</div>
            <div className="text-xs text-(--text-secondary) mt-0.5">terms reviewed</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-green-400">0</div>
            <div className="text-xs text-(--text-secondary) mt-0.5">terms left</div>
          </div>
        </div>
        <p className="text-sm text-(--text-secondary) font-medium mb-3">Next steps</p>
        <div className="space-y-3 max-w-sm">
          <button className="btn w-full flex items-center justify-center gap-2 opacity-40 cursor-not-allowed bg-(--bg-tertiary)" disabled title="Coming soon">
            <BookOpen className="w-4 h-4" /> Practice with questions
          </button>
          <button className="btn btn-secondary w-full" onClick={onRestart}>
            Restart Flashcards
          </button>
          <button className="text-sm text-(--accent) hover-underline w-full text-center block" onClick={onBackToLast}>
            Back to last question
          </button>
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

  const current = queue[index];

  useEffect(() => {
    Promise.all([quizlet.getDeck(deckId), quizlet.deckStats(deckId)]).then(([deck, stats]) => {
      setTitle(deck.title);
      setCards(deck.cards);
      setQueue(deck.cards);
      setStudiedToday(stats.studied_today);
      setLoading(false);
    });
    const saved = localStorage.getItem(`quizlet-fav-${deckId}`);
    if (saved) setFavorites(new Set(JSON.parse(saved)));
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
    setFavorites(prev => {
      const next = new Set(prev);
      next.has(cardId) ? next.delete(cardId) : next.add(cardId);
      localStorage.setItem(`quizlet-fav-${deckId}`, JSON.stringify([...next]));
      return next;
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
    setTimeout(() => { setShowOptions(false); setClosingOptions(false); }, 260);
  };

  // Keyboard shortcuts — ref keeps handler fresh without re-registering the listener
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (showOptions) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); trackProgress ? markCard(true)  : goNext(); break;
      case 'ArrowLeft':  e.preventDefault(); trackProgress ? markCard(false) : goPrev(); break;
      case ' ':          e.preventDefault(); flipHook.flip(); break;
      case 's': case 'S': if (current) starCard(current.id); break;
      case 'h': case 'H': toggleShuffle(); break;
      case 'd': case 'D': setFrontSide('definition'); break;
      case 't': case 'T': setFrontSide('term'); break;
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

  if (sessionDone && trackProgress) {
    return (
      <EndScreen title={title} total={queue.length} known={known} unknown={unknown}
        onRestart={() => restart()} onBack={() => navigate('/')}
        onRestartUnknown={() => restart(cards.filter(c => unknown.has(c.id)))} />
    );
  }

  if (sessionDone && !trackProgress) {
    return (
      <SimpleEndScreen
        title={title}
        total={queue.length}
        onRestart={() => restart()}
        onBackToLast={() => { setSessionDone(false); advance(queue.length - 1); }}
        onBack={() => navigate('/')}
      />
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
          <div className="flex items-center gap-2">
            <button className="p-1 transition-colors" onClick={e => current && toggleFavorite(current.id, e)} title="Favorite">
              <Star className={`w-4 h-4 transition-colors ${isFaved ? 'fill-(--accent) text-(--accent)' : 'text-(--text-secondary) hover:text-(--accent)'}`} />
            </button>
          </div>
        </div>

        {/* Content */}
        {hasImage ? (
          <div className="flex-1 flex min-h-0">
            <div className="flex-1 flex items-center justify-center px-6 py-4 border-r border-(--bg-tertiary)">
              <p className="text-2xl font-medium leading-snug text-center">{text}</p>
            </div>
            <div className="flex-1 p-4">
              <img src={current!.image!} alt="" className="w-full h-full object-contain rounded-lg" />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 py-4 min-h-0">
            <p className="text-2xl font-medium leading-snug text-center w-full">{text}</p>
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

      {/* Desktop mode grid — above card */}
      <div className="hidden sm:block">
        <ModeGrid />
      </div>

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
              <span
                className={`text-4xl font-bold ${feedback === 'unknown' ? 'text-orange-400' : 'text-green-400'}`}
              >
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

      {/* Bottom controls — mobile: 2 rows (nav centered + toggle/icons), desktop: 1 row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">

        {/* Row 1 on mobile: nav centered + bigger. Middle section on desktop. */}
        <div className="flex items-center justify-center gap-3 sm:order-2">
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
          <span className="text-sm text-(--text-secondary) text-center tabular-nums whitespace-nowrap px-1">{index + 1} / {queue.length}</span>
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

        {/* Row 2 on mobile: toggle + icons space-between. On desktop: dissolves so
            children sit directly in the parent flex as order-1 and order-3. */}
        <div className="flex items-center justify-between sm:contents">
          <button className="flex items-center gap-2 text-sm shrink-0 sm:order-1" onClick={toggleTrackProgress}>
            <span className={trackProgress ? 'text-(--accent)' : 'text-(--text-secondary)'}>Track progress</span>
            <div className={`relative w-9 h-5 rounded-full transition-colors ${trackProgress ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${trackProgress ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </div>
          </button>

          <div className="flex items-center gap-1 shrink-0 sm:order-3">
            {trackProgress ? (
              <button className={`icon-btn ${history.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
                onClick={undoLast} disabled={history.length === 0} title="Undo">
                <Undo2 className="w-4 h-4" />
              </button>
            ) : (
              <button className={`icon-btn ${isAutoplay ? 'text-(--accent)' : ''}`}
                onClick={() => setIsAutoplay(a => !a)} title={isAutoplay ? 'Stop' : 'Autoplay'}>
                <Play className={`w-4 h-4 ${isAutoplay ? 'fill-current' : ''}`} />
              </button>
            )}
            <button className={`icon-btn ${isShuffled ? 'text-(--accent)' : ''}`} onClick={toggleShuffle} title={isShuffled ? 'Unshuffle' : 'Shuffle'}>
              <Shuffle className="w-4 h-4" />
            </button>
            <button className="icon-btn" title="Options" onClick={() => setShowOptions(true)}><Settings className="w-4 h-4" /></button>
            <button className="icon-btn" title="Fullscreen (coming soon)"><Maximize2 className="w-4 h-4" /></button>
          </div>
        </div>

      </div>

      {/* Progress bar */}
      <div className="w-full bg-(--bg-tertiary) rounded-full h-1 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300"
          style={{ width: `${progressPercent}%`, background: 'var(--accent)' }} />
      </div>

      {/* Mobile mode grid — below progress bar */}
      <div className="block sm:hidden">
        <ModeGrid mobile />
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
              <div className="relative flex-1">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-secondary) pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search terms..."
                  value={listSearch}
                  onChange={e => setListSearch(e.target.value)}
                  className="w-full bg-(--bg-secondary) border border-(--bg-tertiary) rounded-lg pl-8 pr-4 py-2 text-sm placeholder:text-(--text-secondary) focus:outline-none focus:border-(--accent)"
                />
              </div>
              <select
                value={listFilter}
                onChange={e => setListFilter(e.target.value as typeof listFilter)}
                className="text-xs bg-(--bg-secondary) border border-(--bg-tertiary) rounded-lg px-3 py-1.5 text-(--text-secondary) cursor-pointer focus:outline-none focus:border-(--accent) shrink-0"
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
                    {/* Star top-right */}
                    <button
                      onClick={e => toggleFavorite(card.id, e)}
                      className="absolute top-2 right-2 z-10 p-1"
                    >
                      <Star className={`w-3.5 h-3.5 transition-colors ${isFavedCard ? 'fill-(--accent) text-(--accent)' : 'text-(--text-secondary) hover:text-(--accent)'}`} />
                    </button>

                    {/* Two-half split */}
                    <div className="flex" style={{ minHeight: '88px' }}>
                      {/* Left: TERM */}
                      <div className="flex-1 flex flex-col p-3 border-r border-(--bg-tertiary)">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-secondary) mb-1.5">Term</span>
                        <p className="text-sm font-medium leading-snug flex-1 flex items-center">{card.front}</p>
                      </div>
                      {/* Right: DEFINITION + image */}
                      <div className="flex-1 flex flex-col p-3 pr-8">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-secondary)">Definition</span>
                          {isKnownCard && <span className="text-[10px] font-semibold text-green-400 ml-auto">Mastered</span>}
                          {isUnknownCard && <span className="text-[10px] font-semibold text-orange-400 ml-auto">Learning</span>}
                        </div>
                        <div className="flex-1 flex gap-2 min-h-0 items-center">
                          <p className="text-sm text-white leading-snug flex-1">{card.back}</p>
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
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={closeOptions}>
          <div
            className={`${closingOptions ? 'options-panel-closing' : 'options-panel'} bg-(--bg-secondary) border-l border-(--bg-tertiary) w-full max-w-sm h-full overflow-y-auto shadow-2xl flex flex-col divide-y divide-white/8`}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 shrink-0">
              <h2 className="text-xl font-bold">Options</h2>
              <button className="icon-btn" onClick={closeOptions} title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Track progress */}
            <div className="p-6 flex items-center justify-between gap-4">
              <div>
                <p className="font-medium text-sm">Track progress</p>
                <p className="text-xs text-(--text-secondary) mt-0.5">Toggle off returns to card 1. Toggle on resumes where you left off.</p>
              </div>
              <button onClick={toggleTrackProgress} className="shrink-0">
                <div className={`relative w-9 h-5 rounded-full transition-colors ${trackProgress ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${trackProgress ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
              </button>
            </div>

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
            <div className="p-6">
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
        .options-panel         { animation: panelSlideIn  0.28s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .options-panel-closing { animation: panelSlideOut 0.26s cubic-bezier(0.4,  0, 1,    1) forwards; }

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
