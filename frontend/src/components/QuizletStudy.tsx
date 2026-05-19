import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Shuffle, ChevronLeft, ChevronRight } from 'lucide-react';
import { quizlet, type QuizletCard } from '../api';

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function QuizletStudy() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const deckId = Number(id);

  const [title, setTitle] = useState('');
  const [cards, setCards] = useState<QuizletCard[]>([]);
  const [queue, setQueue] = useState<QuizletCard[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionDone, setSessionDone] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [isShuffled, setIsShuffled] = useState(false);

  useEffect(() => {
    quizlet.getDeck(deckId).then(deck => {
      setTitle(deck.title);
      setCards(deck.cards);
      setQueue(deck.cards);
      setLoading(false);
    });
  }, [deckId]);

  const current = queue[index];

  const handleAgain = () => {
    if (!current) return;
    quizlet.review(deckId, current.id, 1);
    setReviewed(r => r + 1);
    // Move to end of queue
    const newQueue = [...queue.slice(index + 1), current];
    if (newQueue.length === 0) {
      setSessionDone(true);
    } else {
      setQueue([...queue.slice(0, index), ...newQueue]);
      setFlipped(false);
    }
  };

  const handleGotIt = () => {
    if (!current) return;
    quizlet.review(deckId, current.id, 2);
    setReviewed(r => r + 1);
    const next = index + 1;
    if (next >= queue.length) {
      setSessionDone(true);
    } else {
      setIndex(next);
      setFlipped(false);
    }
  };

  const restart = (doShuffle = false) => {
    const newQueue = doShuffle ? shuffle(cards) : [...cards];
    setQueue(newQueue);
    setIndex(0);
    setFlipped(false);
    setSessionDone(false);
    setReviewed(0);
    setIsShuffled(doShuffle);
  };

  const progress = queue.length > 0 ? Math.round((index / queue.length) * 100) : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="skeleton h-8 w-48 rounded-full" />
      </div>
    );
  }

  if (sessionDone) {
    return (
      <div className="space-y-6 max-w-xl mx-auto">
        <button onClick={() => navigate('/quizlet')} className="flex items-center gap-2 text-(--text-secondary) hover-accent">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="card text-center space-y-4 py-12">
          <div className="text-5xl">🎉</div>
          <h2 className="text-2xl font-bold">{title}</h2>
          <p className="text-(--text-secondary)">Session complete! Reviewed {reviewed} cards.</p>
          <div className="flex gap-3 justify-center flex-wrap">
            <button className="btn btn-primary flex items-center gap-2" onClick={() => restart(false)}>
              <RotateCcw className="w-4 h-4" /> Study Again
            </button>
            <button className="btn btn-secondary flex items-center gap-2" onClick={() => restart(true)}>
              <Shuffle className="w-4 h-4" /> Shuffle & Restart
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={() => navigate('/quizlet')} className="flex items-center gap-2 text-(--text-secondary) hover-accent">
          <ArrowLeft className="w-4 h-4" /> {title}
        </button>
        <div className="flex items-center gap-2">
          <button
            className="icon-btn"
            onClick={() => restart(!isShuffled)}
            title={isShuffled ? 'Original order' : 'Shuffle'}
          >
            <Shuffle className={`w-4 h-4 ${isShuffled ? 'text-(--accent)' : ''}`} />
          </button>
          <button className="icon-btn" onClick={() => restart(isShuffled)} title="Restart">
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-(--bg-tertiary) rounded-full h-1.5">
          <div
            className="h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${progress}%`, background: 'var(--accent)' }}
          />
        </div>
        <span className="text-sm text-(--text-secondary) shrink-0">{index + 1} / {queue.length}</span>
      </div>

      {/* Card */}
      <div
        className="card cursor-pointer select-none min-h-64 flex flex-col items-center justify-center text-center relative"
        style={{ border: '2px solid var(--bg-tertiary)', transition: 'border-color 0.15s' }}
        onClick={() => setFlipped(f => !f)}
      >
        <span className="absolute top-3 left-3 text-xs text-(--text-secondary) uppercase tracking-wide">
          {flipped ? 'Definition' : 'Term'}
        </span>
        <p className="text-xl font-medium px-4">
          {flipped ? current?.back : current?.front}
        </p>
        {!flipped && (
          <p className="absolute bottom-3 text-xs text-(--text-secondary)">Click to reveal</p>
        )}
      </div>

      {/* Navigation & answer buttons */}
      <div className="flex gap-3">
        <button
          className="icon-btn p-2"
          onClick={() => { setIndex(i => Math.max(0, i - 1)); setFlipped(false); }}
          disabled={index === 0}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        {flipped ? (
          <>
            <button
              className="btn btn-error flex-1"
              onClick={handleAgain}
            >
              Again
            </button>
            <button
              className="btn btn-success flex-1"
              onClick={handleGotIt}
            >
              Got it ✓
            </button>
          </>
        ) : (
          <button
            className="btn btn-secondary flex-1"
            onClick={() => setFlipped(true)}
          >
            Show Answer
          </button>
        )}

        <button
          className="icon-btn p-2"
          onClick={() => { setIndex(i => Math.min(queue.length - 1, i + 1)); setFlipped(false); }}
          disabled={index >= queue.length - 1}
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
