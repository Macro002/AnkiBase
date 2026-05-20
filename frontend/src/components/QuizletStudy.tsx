import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Star, ChevronLeft, ChevronRight,
  Play, Undo2, Shuffle, Settings, Maximize2, X, Check,
  TrendingUp, Lightbulb, CreditCard, BookOpen, ClipboardList,
  Grid3X3, Zap, Gamepad2,
} from 'lucide-react';
import { Flashcard, useFlashcard } from 'react-quizlet-flashcard';
import 'react-quizlet-flashcard/dist/index.css';
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
  { id: 'flashcards', label: 'Flashcards', Icon: CreditCard,    active: true  },
  { id: 'learn',      label: 'Learn',      Icon: BookOpen,      active: false },
  { id: 'test',       label: 'Test',       Icon: ClipboardList, active: false },
  { id: 'blocks',     label: 'Blocks',     Icon: Grid3X3,       active: false },
  { id: 'blast',      label: 'Blast',      Icon: Zap,           active: false },
  { id: 'match',      label: 'Match',      Icon: Gamepad2,      active: false },
];

function ModeGrid() {
  return (
    <div className="grid grid-cols-3 gap-2">
      {MODES.map(({ id, label, Icon, active }) => (
        <button
          key={id}
          disabled={!active}
          title={active ? undefined : 'Coming soon'}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
            active
              ? 'bg-(--accent)/10 text-(--accent)'
              : 'bg-(--bg-secondary) text-(--text-secondary) opacity-40 cursor-not-allowed'
          }`}
        >
          <div className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${active ? 'bg-(--accent)/20' : 'bg-(--bg-tertiary)'}`}>
            <Icon className="w-4 h-4" />
          </div>
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

export function QuizletStudy() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const deckId = Number(id);

  const [title, setTitle] = useState('');
  const [cards, setCards] = useState<QuizletCard[]>([]);
  const [queue, setQueue] = useState<QuizletCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [studiedToday, setStudiedToday] = useState(0);

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

  const [isShuffled, setIsShuffled] = useState(false);
  const [isAutoplay, setIsAutoplay] = useState(false);
  const autoplayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const goNext = useCallback(() => { if (index < queue.length - 1) advance(index + 1); }, [index, queue.length, advance]);
  const goPrev = useCallback(() => { if (index > 0) advance(index - 1); }, [index, advance]);

  const toggleFavorite = (cardId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites(prev => {
      const next = new Set(prev);
      next.has(cardId) ? next.delete(cardId) : next.add(cardId);
      localStorage.setItem(`quizlet-fav-${deckId}`, JSON.stringify([...next]));
      return next;
    });
  };

  const markCard = (isKnown: boolean) => {
    if (!current) return;
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
    if (index >= queue.length - 1) setSessionDone(true);
    else advance(index + 1);
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
    setTrackProgress(t => !t);
    setKnown(new Set()); setUnknown(new Set()); setHistory([]);
    setSessionDone(false); setIsAutoplay(false);
    advance(0);
  };

  const restart = (subset?: QuizletCard[]) => {
    const base = subset ?? (isShuffled ? shuffle([...cards]) : [...cards]);
    setQueue(base);
    setKnown(new Set()); setUnknown(new Set()); setHistory([]);
    setSessionDone(false);
    advance(0);
  };

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
    const text = isBack ? current?.back : current?.front;
    const hasImage = !!current?.image;
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
                ? <span className="leading-snug">{generateHint(current?.back ?? '')}</span>
                : 'Get a hint'}
            </button>
          ) : (
            <span className="text-xs text-(--text-secondary) uppercase tracking-wide">Definition</span>
          )}
          <div className="flex items-center gap-2">
            <button className="p-1 transition-colors" onClick={e => current && toggleFavorite(current.id, e)} title="Favorite">
              <Star className={`w-4 h-4 transition-colors ${isFaved ? 'fill-(--accent) text-(--accent)' : 'text-(--text-secondary) hover:text-(--accent)'}`} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex items-center justify-center px-6 py-4 min-h-0">
          {hasImage ? (
            <div className="flex items-center justify-center gap-8 w-full">
              <p className="text-2xl font-medium leading-snug text-center max-w-[44%]">{text}</p>
              <img src={current!.image!} alt="" className="max-w-[44%] max-h-52 w-auto h-auto object-contain rounded-lg shrink-0" />
            </div>
          ) : (
            <div className="w-full flex flex-col items-center justify-center text-center">
              <p className="text-2xl font-medium leading-snug">{text}</p>
            </div>
          )}
        </div>

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

      <ModeGrid />

      {/* Card with 3D flip + slide-in */}
      <div style={{ perspective: '1100px' }}>
        <div
          key={index}
          className={slideDir === 'right' ? 'card-slide-right' : 'card-slide-left'}
        >
          <Flashcard
            flipHook={flipHook}
            front={{ html: renderFaceContent(false) }}
            back={{ html: renderFaceContent(true) }}
            style={{ height: '28rem' }}
          />
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-between gap-2">
        {/* Track progress toggle */}
        <button className="flex items-center gap-2 text-sm shrink-0" onClick={toggleTrackProgress}>
          <span className={trackProgress ? 'text-(--accent)' : 'text-(--text-secondary)'}>Track progress</span>
          <div className={`relative w-9 h-5 rounded-full transition-colors ${trackProgress ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${trackProgress ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </button>

        {/* Nav / mark */}
        <div className="flex items-center gap-2">
          <button
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
              trackProgress ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'bg-(--bg-secondary) text-(--text-secondary) hover-accent disabled:opacity-30'
            }`}
            onClick={() => trackProgress ? markCard(false) : goPrev()}
            disabled={!trackProgress && index === 0}
          >
            {trackProgress ? <X className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
          </button>
          <span className="text-sm text-(--text-secondary) w-16 text-center tabular-nums">{index + 1} / {queue.length}</span>
          <button
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
              trackProgress ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                : 'bg-(--bg-secondary) text-(--text-secondary) hover-accent disabled:opacity-30'
            }`}
            onClick={() => trackProgress ? markCard(true) : goNext()}
            disabled={!trackProgress && index === queue.length - 1}
          >
            {trackProgress ? <Check className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </button>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1 shrink-0">
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
          <button className="icon-btn" title="Settings (coming soon)"><Settings className="w-4 h-4" /></button>
          <button className="icon-btn" title="Fullscreen (coming soon)"><Maximize2 className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-(--bg-tertiary) rounded-full h-1 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300"
          style={{ width: `${progressPercent}%`, background: trackProgress ? 'linear-gradient(to right,#4ade80,#22c55e)' : 'var(--accent)' }} />
      </div>

      <style>{`
        /* Override library defaults for dark theme */
        .flashcard-wrapper {
          width: 100% !important;
          bottom: auto !important;
          --front-bg: var(--bg-secondary);
          --back-bg: var(--bg-secondary);
          --box-shadow: none;
          --border-radius: 0.75rem;
        }
        .flashcard__front, .flashcard__back {
          color: inherit !important;
        }

        /* Card slide animations */
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
      `}</style>
    </div>
  );
}
