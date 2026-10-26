import { useEffect, useRef, useState } from 'react';
import { Trophy, RotateCcw, Timer } from 'lucide-react';
import MatchIcon from '../../assets/icons/brand-match.svg?react';
import { quizlet, type QuizletCard } from '../../api';
import { shuffle, stripHtml, formatTime } from './shared';
import { Html } from './ui';

/** Quizlet Match: six pairs per game, +1s for every wrong match. */
const PAIRS = 6;
const PENALTY_MS = 1000;

interface Tile { key: string; cardId: number; side: 'term' | 'definition'; html: string }
interface MatchSaved { best: number | null; games: number }

export function MatchMode({ deckId, cards, onReviewed }: { deckId: number; cards: QuizletCard[]; onReviewed: () => void }) {
  const [phase, setPhase] = useState<'start' | 'play' | 'done'>('start');
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [wrong, setWrong] = useState<[string, string] | null>(null);
  const [penalty, setPenalty] = useState(0);
  const [startAt, setStartAt] = useState(0);
  const [now, setNow] = useState(0);
  const [final, setFinal] = useState(0);
  const [saved, setSaved] = useState<MatchSaved>({ best: null, games: 0 });
  const [newBest, setNewBest] = useState(false);
  const [flash, setFlash] = useState(false);
  const missed = useRef<Set<number>>(new Set());

  useEffect(() => {
    quizlet.getState<MatchSaved>(deckId, 'match').then(r => { if (r.state) setSaved(r.state); }).catch(() => {});
  }, [deckId]);

  useEffect(() => {
    if (phase !== 'play') return;
    let raf = 0;
    const tick = () => { setNow(Date.now()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const start = () => {
    const picked = shuffle(cards).slice(0, Math.min(PAIRS, cards.length));
    const t: Tile[] = picked.flatMap(c => [
      { key: `t${c.id}`, cardId: c.id, side: 'term' as const, html: c.front },
      { key: `d${c.id}`, cardId: c.id, side: 'definition' as const, html: c.back || (c.image ? `<img src="${c.image.replace(/"/g, '&quot;')}" alt="">` : '') },
    ]);
    setTiles(shuffle(t));
    setCleared(new Set());
    setSelected(null);
    setWrong(null);
    setPenalty(0);
    setNewBest(false);
    missed.current = new Set();
    const s = Date.now();
    setStartAt(s);
    setNow(s);
    setPhase('play');
  };

  const finish = (penaltyTotal: number, pairCardIds: number[]) => {
    const time = now - startAt + penaltyTotal;
    setFinal(time);
    setPhase('done');
    const isBest = saved.best == null || time < saved.best;
    setNewBest(isBest);
    const next = { best: isBest ? time : saved.best, games: saved.games + 1 };
    setSaved(next);
    quizlet.putState(deckId, 'match', next).catch(() => {});
    pairCardIds.forEach(id => quizlet.review(deckId, id, missed.current.has(id) ? 1 : 2).then(onReviewed).catch(() => {}));
  };

  const click = (tile: Tile) => {
    if (cleared.has(tile.key) || wrong) return;
    if (!selected) { setSelected(tile.key); return; }
    if (selected === tile.key) { setSelected(null); return; }
    const a = tiles.find(t => t.key === selected)!;
    if (a.cardId === tile.cardId && a.side !== tile.side) {
      const next = new Set(cleared).add(a.key).add(tile.key);
      setCleared(next);
      setSelected(null);
      if (next.size === tiles.length) finish(penalty, [...new Set(tiles.map(t => t.cardId))]);
    } else {
      missed.current.add(a.cardId).add(tile.cardId);
      setWrong([a.key, tile.key]);
      setPenalty(p => p + PENALTY_MS);
      setFlash(true);
      setTimeout(() => { setWrong(null); setSelected(null); setFlash(false); }, 450);
    }
  };

  if (cards.length < 2) {
    return <div className="card text-center py-12 text-(--text-secondary)">Match needs at least 2 terms.</div>;
  }

  if (phase === 'start') {
    return (
      <div className="card text-center space-y-5 py-10">
        <MatchIcon className="w-14 h-14 mx-auto" style={{ color: 'rgba(var(--accent-rgb), 0.6)' }} />
        <div>
          <h2 className="text-2xl font-bold">Ready to play?</h2>
          <p className="text-sm text-(--text-secondary) mt-2 max-w-sm mx-auto">
            Match all the terms with their definitions as fast as you can. Avoid wrong matches — they add 1 second to your time.
          </p>
        </div>
        {saved.best != null && (
          <p className="text-sm flex items-center justify-center gap-1.5 text-(--text-secondary)">
            <Trophy className="w-4 h-4 text-yellow-400" /> Your best: <span className="font-semibold text-white">{formatTime(saved.best)}</span>
          </p>
        )}
        <button onClick={start} className="btn btn-primary px-10">Start game</button>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="card text-center space-y-5 py-10">
        <h2 className="text-2xl font-bold">{newBest ? 'New personal best!' : 'Nice matching!'}</h2>
        <p className="text-5xl font-bold tabular-nums">{formatTime(final)}</p>
        {penalty > 0 && <p className="text-sm text-(--text-secondary)">including +{penalty / 1000}s for wrong matches</p>}
        {saved.best != null && !newBest && (
          <p className="text-sm text-(--text-secondary) flex items-center justify-center gap-1.5">
            <Trophy className="w-4 h-4 text-yellow-400" /> Best: {formatTime(saved.best)}
          </p>
        )}
        <button onClick={start} className="btn btn-primary px-10 inline-flex items-center gap-2"><RotateCcw className="w-4 h-4" /> Play again</button>
      </div>
    );
  }

  const elapsed = now - startAt + penalty;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className={`flex items-center gap-2 text-2xl font-bold tabular-nums transition-colors ${flash ? 'text-red-400' : ''}`}>
          <Timer className="w-5 h-5 text-(--text-secondary)" /> {formatTime(elapsed)}
          {flash && <span className="text-sm text-red-400 font-semibold">+1s</span>}
        </span>
        <button onClick={() => setPhase('start')} className="text-sm text-(--text-secondary) hover-accent">Quit</button>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {tiles.map(t => {
          const gone = cleared.has(t.key);
          const sel = selected === t.key;
          const bad = wrong?.includes(t.key);
          const len = stripHtml(t.html).length;
          return (
            <button key={t.key} onClick={() => click(t)} disabled={gone}
              className={`match-tile rounded-xl p-2 sm:p-3 flex items-center justify-center text-center overflow-hidden transition-all duration-200 ${
                gone ? 'opacity-0 scale-90 pointer-events-none' :
                bad ? 'bg-red-500/25 ring-2 ring-red-500 match-shake' :
                sel ? 'bg-(--accent)/20 ring-2 ring-(--accent)' : 'bg-(--bg-secondary) hover:bg-(--bg-tertiary)'}`}
              style={{ minHeight: 'clamp(5.5rem, 22vw, 9rem)' }}>
              <Html html={t.html} className={`${len < 25 ? 'text-base sm:text-lg' : len < 70 ? 'text-sm' : 'text-xs'} font-medium leading-snug break-words [&_img]:max-h-20 [&_img]:mx-auto`} />
            </button>
          );
        })}
      </div>
      <style>{`
        @keyframes matchShake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-5px) } 75% { transform: translateX(5px) } }
        .match-shake { animation: matchShake 0.3s ease; }
      `}</style>
    </div>
  );
}
