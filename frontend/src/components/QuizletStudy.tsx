import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Star, Volume2, ChevronLeft, ChevronRight,
  Play, Undo2, Shuffle, Settings, Maximize2, X, Check,
  TrendingUp, Lightbulb, CreditCard, BookOpen, ClipboardList,
  Grid3X3, Zap, Gamepad2,
} from 'lucide-react';
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
  const size = 96;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - percent / 100);
  const color = percent >= 80 ? '#4ade80' : percent >= 50 ? '#facc15' : '#f87171';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
      />
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="middle"
        fill="white" fontSize="16" fontWeight="bold">
        {percent}%
      </text>
    </svg>
  );
}

const MODES = [
  { id: 'flashcards', label: 'Flashcards', Icon: CreditCard, active: true },
  { id: 'learn',      label: 'Learn',      Icon: BookOpen,       active: false },
  { id: 'test',       label: 'Test',       Icon: ClipboardList,  active: false },
  { id: 'blocks',     label: 'Blocks',     Icon: Grid3X3,        active: false },
  { id: 'blast',      label: 'Blast',      Icon: Zap,            active: false },
  { id: 'match',      label: 'Match',      Icon: Gamepad2,       active: false },
];

interface EndScreenProps {
  title: string;
  total: number;
  known: Set<number>;
  unknown: Set<number>;
  onRestart: () => void;
  onRestartUnknown: () => void;
  onBack: () => void;
}

function EndScreen({ title, total, known, unknown, onRestart, onRestartUnknown, onBack }: EndScreenProps) {
  const knownCount = known.size;
  const unknownCount = unknown.size;
  const leftCount = Math.max(0, total - knownCount - unknownCount);
  const percent = total > 0 ? Math.round((knownCount / total) * 100) : 0;

  const getMessage = () => {
    if (percent === 100) return "Perfect score! You know them all!";
    if (percent >= 80) return "Impressive! Just a bit more to go!";
    if (percent >= 60) return "Good progress! Keep it up!";
    return "Keep practicing — you're getting there!";
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-8">
      <button onClick={onBack} className="flex items-center gap-2 text-(--text-secondary) hover-accent text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Decks
      </button>

      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
      </div>

      {/* Mode grid */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map(({ id, label, Icon, active }) => (
          <button
            key={id}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
              active
                ? 'border-(--accent) bg-(--accent)/10 text-(--accent)'
                : 'border-(--bg-tertiary) bg-(--bg-secondary) text-(--text-secondary) opacity-50 cursor-not-allowed'
            }`}
            disabled={!active}
            title={active ? undefined : 'Coming soon'}
          >
            <div className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${active ? 'bg-(--accent)/20' : 'bg-(--bg-tertiary)'}`}>
              <Icon className="w-4 h-4" />
            </div>
            {label}
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="card">
        <h2 className="text-2xl font-bold mb-6">{getMessage()}</h2>
        <div className="flex flex-col sm:flex-row gap-8">
          {/* Left: stats */}
          <div className="flex-1">
            <p className="text-sm text-(--text-secondary) font-medium mb-4">How you're doing</p>
            <div className="flex items-center gap-6">
              <DonutChart percent={percent} />
              <div className="space-y-2 flex-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-sm bg-green-500 inline-block" />
                    Know
                  </span>
                  <span className="font-semibold">{knownCount}</span>
                </div>
                <div className="w-full bg-(--bg-tertiary) rounded-full h-1.5">
                  <div className="h-1.5 rounded-full bg-green-500 transition-all" style={{ width: `${total > 0 ? (knownCount / total) * 100 : 0}%` }} />
                </div>
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-sm bg-orange-500 inline-block" />
                    Still learning
                  </span>
                  <span className="font-semibold">{unknownCount}</span>
                </div>
                <div className="w-full bg-(--bg-tertiary) rounded-full h-1.5">
                  <div className="h-1.5 rounded-full bg-orange-500 transition-all" style={{ width: `${total > 0 ? (unknownCount / total) * 100 : 0}%` }} />
                </div>
                {leftCount > 0 && (
                  <>
                    <div className="flex items-center justify-between text-sm mt-2">
                      <span className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-sm bg-(--bg-tertiary) inline-block" />
                        Terms left
                      </span>
                      <span className="font-semibold">{leftCount}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right: next steps */}
          <div className="flex-1">
            <p className="text-sm text-(--text-secondary) font-medium mb-4">Next steps</p>
            <div className="space-y-3">
              <button className="btn btn-primary w-full flex items-center justify-center gap-2 opacity-50 cursor-not-allowed" disabled title="Coming soon">
                <BookOpen className="w-4 h-4" /> Practice with questions
              </button>
              {unknownCount > 0 && (
                <button
                  className="btn btn-secondary w-full flex items-center justify-center gap-2"
                  onClick={onRestartUnknown}
                >
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

  // Data
  const [title, setTitle] = useState('');
  const [cards, setCards] = useState<QuizletCard[]>([]);
  const [queue, setQueue] = useState<QuizletCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [studiedToday, setStudiedToday] = useState(0);

  // Card state
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [hintShown, setHintShown] = useState(false);

  // Favorites (localStorage)
  const [favorites, setFavorites] = useState<Set<number>>(new Set());

  // Track progress
  const [trackProgress, setTrackProgress] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const [unknown, setUnknown] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<Array<{ cardId: number; wasKnown: boolean }>>([]);
  const [sessionDone, setSessionDone] = useState(false);

  // Controls
  const [isShuffled, setIsShuffled] = useState(false);
  const [isAutoplay, setIsAutoplay] = useState(false);
  const autoplayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = queue[index];

  useEffect(() => {
    Promise.all([
      quizlet.getDeck(deckId),
      quizlet.deckStats(deckId),
    ]).then(([deck, stats]) => {
      setTitle(deck.title);
      setCards(deck.cards);
      setQueue(deck.cards);
      setStudiedToday(stats.studied_today);
      setLoading(false);
    });
    const saved = localStorage.getItem(`quizlet-fav-${deckId}`);
    if (saved) setFavorites(new Set(JSON.parse(saved)));
  }, [deckId]);

  const toggleFavorite = (cardId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites(prev => {
      const next = new Set(prev);
      next.has(cardId) ? next.delete(cardId) : next.add(cardId);
      localStorage.setItem(`quizlet-fav-${deckId}`, JSON.stringify([...next]));
      return next;
    });
  };

  const advance = useCallback((nextIndex: number) => {
    setIndex(nextIndex);
    setFlipped(false);
    setHintShown(false);
  }, []);

  const goNext = useCallback(() => {
    if (index < queue.length - 1) advance(index + 1);
  }, [index, queue.length, advance]);

  const goPrev = useCallback(() => {
    if (index > 0) advance(index - 1);
  }, [index, advance]);

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

    if (index >= queue.length - 1) {
      setSessionDone(true);
    } else {
      advance(index + 1);
    }
  };

  const undoLast = () => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    if (last.wasKnown) {
      setKnown(prev => { const n = new Set(prev); n.delete(last.cardId); return n; });
    } else {
      setUnknown(prev => { const n = new Set(prev); n.delete(last.cardId); return n; });
    }
    if (index > 0) advance(index - 1);
  };

  const toggleShuffle = () => {
    setQueue(isShuffled ? [...cards] : shuffle([...cards]));
    setIsShuffled(s => !s);
    advance(0);
  };

  const toggleTrackProgress = () => {
    setTrackProgress(t => !t);
    setKnown(new Set());
    setUnknown(new Set());
    setHistory([]);
    setSessionDone(false);
    setIsAutoplay(false);
    advance(0);
  };

  const restart = (subset?: QuizletCard[]) => {
    const base = subset ?? (isShuffled ? shuffle([...cards]) : [...cards]);
    setQueue(base);
    setKnown(new Set());
    setUnknown(new Set());
    setHistory([]);
    setSessionDone(false);
    advance(0);
  };

  // Autoplay
  useEffect(() => {
    if (!isAutoplay || trackProgress) return;
    autoplayRef.current = setTimeout(() => {
      if (!flipped) {
        setFlipped(true);
      } else {
        if (index < queue.length - 1) {
          advance(index + 1);
        } else {
          setIsAutoplay(false);
        }
      }
    }, 2000);
    return () => { if (autoplayRef.current) clearTimeout(autoplayRef.current); };
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
        <div className="skeleton h-72 rounded-xl" />
        <div className="skeleton h-8 w-full rounded" />
      </div>
    );
  }

  if (sessionDone && trackProgress) {
    return (
      <EndScreen
        title={title}
        total={queue.length}
        known={known}
        unknown={unknown}
        onRestart={() => restart()}
        onRestartUnknown={() => {
          const unknownCards = cards.filter(c => unknown.has(c.id));
          restart(unknownCards);
        }}
        onBack={() => navigate('/')}
      />
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4 pb-8">
      {/* Back */}
      <button onClick={() => navigate('/')} className="flex items-center gap-2 text-(--text-secondary) hover-accent text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Decks
      </button>

      {/* Title + stats */}
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <div className="flex items-center gap-5 mt-1 text-sm text-(--text-secondary)">
          <span className="flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-green-400" />
            {studiedToday} studied today
          </span>
          <span className="flex items-center gap-1.5">
            <Star className="w-3.5 h-3.5 text-yellow-400" />
            {favorites.size} favorited
          </span>
        </div>
      </div>

      {/* Mode grid */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map(({ id, label, Icon, active }) => (
          <button
            key={id}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
              active
                ? 'border-(--accent) bg-(--accent)/10 text-(--accent)'
                : 'border-(--bg-tertiary) bg-(--bg-secondary) text-(--text-secondary) opacity-50 cursor-not-allowed'
            }`}
            disabled={!active}
            title={active ? undefined : 'Coming soon'}
          >
            <div className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${active ? 'bg-(--accent)/20' : 'bg-(--bg-tertiary)'}`}>
              <Icon className="w-4 h-4" />
            </div>
            {label}
          </button>
        ))}
      </div>

      {/* Card */}
      <div
        className="relative rounded-xl bg-(--bg-secondary) border-2 border-(--bg-tertiary) cursor-pointer select-none min-h-72 flex flex-col transition-colors hover:border-(--accent)/30"
        onClick={() => { setFlipped(f => !f); setHintShown(false); }}
      >
        {/* Card top bar */}
        <div className="flex items-center justify-between px-4 pt-4">
          <button
            className={`flex items-center gap-1.5 text-xs transition-colors ${hintShown ? 'text-(--accent)' : 'text-(--text-secondary) hover-accent'}`}
            onClick={e => { e.stopPropagation(); setHintShown(h => !h); setFlipped(false); }}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            {hintShown ? 'Hide hint' : 'Get a hint'}
          </button>
          <div className="flex items-center gap-2">
            <button
              className="text-(--text-secondary) hover-accent transition-colors p-1"
              onClick={e => e.stopPropagation()}
              title="Audio (coming soon)"
            >
              <Volume2 className="w-4 h-4" />
            </button>
            <button
              className="transition-colors p-1"
              onClick={e => current && toggleFavorite(current.id, e)}
              title="Favorite"
            >
              <Star className={`w-4 h-4 transition-colors ${current && favorites.has(current.id) ? 'fill-yellow-400 text-yellow-400' : 'text-(--text-secondary) hover:text-yellow-400'}`} />
            </button>
          </div>
        </div>

        {/* Card content */}
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-6 min-h-56">
          {hintShown ? (
            <div className="text-center space-y-2">
              <p className="text-xs text-(--text-secondary) uppercase tracking-wide">Hint</p>
              <p className="text-lg text-(--text-secondary) italic">{current?.back}</p>
            </div>
          ) : (
            <div className="text-center space-y-4">
              {current?.image && !flipped && (
                <img src={current.image} alt="" className="w-36 h-28 object-cover rounded-lg mx-auto" />
              )}
              <p className="text-2xl font-medium">
                {flipped ? current?.back : current?.front}
              </p>
            </div>
          )}
        </div>

        {/* Flip label */}
        <div className="pb-3 text-center">
          <span className="text-xs text-(--text-secondary)">
            {hintShown ? '' : flipped ? 'Definition' : 'Click to flip'}
          </span>
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-between gap-2">
        {/* Track progress toggle */}
        <button
          className="flex items-center gap-2 text-sm shrink-0"
          onClick={toggleTrackProgress}
        >
          <span className={`text-sm ${trackProgress ? 'text-(--accent)' : 'text-(--text-secondary)'}`}>
            Track progress
          </span>
          <div className={`relative w-9 h-5 rounded-full transition-colors ${trackProgress ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'}`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${trackProgress ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </button>

        {/* Nav / mark buttons */}
        <div className="flex items-center gap-2">
          <button
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors font-bold ${
              trackProgress
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'bg-(--bg-secondary) text-(--text-secondary) hover-accent disabled:opacity-30'
            }`}
            onClick={() => trackProgress ? markCard(false) : goPrev()}
            disabled={!trackProgress && index === 0}
          >
            {trackProgress ? <X className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
          </button>

          <span className="text-sm text-(--text-secondary) w-16 text-center tabular-nums">
            {index + 1} / {queue.length}
          </span>

          <button
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors font-bold ${
              trackProgress
                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
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
            <button
              className={`icon-btn ${history.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
              onClick={undoLast}
              disabled={history.length === 0}
              title="Undo"
            >
              <Undo2 className="w-4 h-4" />
            </button>
          ) : (
            <button
              className={`icon-btn ${isAutoplay ? 'text-(--accent)' : ''}`}
              onClick={() => setIsAutoplay(a => !a)}
              title={isAutoplay ? 'Stop autoplay' : 'Autoplay'}
            >
              <Play className={`w-4 h-4 ${isAutoplay ? 'fill-(--accent)' : ''}`} />
            </button>
          )}
          <button
            className={`icon-btn ${isShuffled ? 'text-(--accent)' : ''}`}
            onClick={toggleShuffle}
            title={isShuffled ? 'Unshuffle' : 'Shuffle'}
          >
            <Shuffle className="w-4 h-4" />
          </button>
          <button className="icon-btn" title="Settings (coming soon)">
            <Settings className="w-4 h-4" />
          </button>
          <button className="icon-btn" title="Fullscreen (coming soon)">
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-(--bg-tertiary) rounded-full h-1 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${progressPercent}%`,
            background: trackProgress ? 'linear-gradient(to right, #4ade80, #22c55e)' : 'var(--accent)',
          }}
        />
      </div>
    </div>
  );
}
