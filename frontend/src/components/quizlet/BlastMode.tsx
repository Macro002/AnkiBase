import { useCallback, useEffect, useRef, useState } from 'react';
import { Heart, Trophy, RotateCcw, Zap } from 'lucide-react';
import BlastIcon from '../../assets/icons/brand-blast.svg?react';
import { quizlet, type QuizletCard } from '../../api';
import { answerOf, pickDistractors, promptOf, resolveSide, shuffle, stripHtml, type AnswerWith, type Side } from './shared';
import { Html, Segmented } from './ui';

/**
 * Blast (single player): the prompt sits at the bottom, answers ride on falling
 * asteroids. Blast the right one for points; a wrong hit costs points and your
 * streak. Let the right one slip past and you lose a life.
 */

type Speed = 'slow' | 'normal' | 'fast';
const SPEED_PX: Record<Speed, number> = { slow: 38, normal: 58, fast: 85 };
const LIVES = 3;
const POINTS = 100;
const WRONG_POINTS = 50;

interface Asteroid { key: string; cardId: number; x: number; y: number; vx: number; spin: number; size: number; html: string; state: 'live' | 'hit' | 'boom' }
interface Wave { cardId: number; side: Side; asteroids: Asteroid[] }
interface BlastSaved { best: number }
/** Render snapshot of the mutable game state, published once per frame. */
interface View { wave: Wave | null; score: number; lives: number; remaining: number; message: string | null }

export function BlastMode({ deckId, cards, onReviewed }: { deckId: number; cards: QuizletCard[]; onReviewed: () => void }) {
  const [phase, setPhase] = useState<'start' | 'play' | 'over'>('start');
  const [speed, setSpeed] = useState<Speed>('normal');
  const [choices, setChoices] = useState(4);
  const [duration, setDuration] = useState(120);
  const [answerWith, setAnswerWith] = useState<AnswerWith>('definition');
  const [best, setBest] = useState<number | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [result, setResult] = useState<{ score: number; hits: number; misses: number; newBest: boolean; review: number[] } | null>(null);

  const fieldRef = useRef<HTMLDivElement>(null);
  const reviewed = useRef(onReviewed);
  useEffect(() => { reviewed.current = onReviewed; }, [onReviewed]);
  const g = useRef({
    wave: null as Wave | null, score: 0, lives: LIVES, streak: 0, hits: 0, misses: 0,
    endAt: 0, last: 0, now: 0, speedMul: 1, missed: new Map<number, number>(), message: '' as string, messageUntil: 0, nextWaveAt: 0,
  });

  useEffect(() => {
    quizlet.getState<BlastSaved>(deckId, 'blast').then(r => { if (r.state) setBest(r.state.best); }).catch(() => {});
  }, [deckId]);

  const fieldSize = () => {
    const r = fieldRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 600, h: r?.height ?? 440 };
  };

  const spawnWave = useCallback(() => {
    const st = g.current;
    // Lean toward terms you've missed.
    const weighted = cards.flatMap(c => Array(1 + (st.missed.get(c.id) ?? 0) * 2).fill(c) as QuizletCard[]);
    const target = weighted[Math.floor(Math.random() * weighted.length)];
    const side = resolveSide(answerWith);
    const opts = shuffle([target, ...pickDistractors(target, cards, side, Math.min(choices, cards.length) - 1)]);
    const { w } = fieldSize();
    const lane = w / opts.length;
    const size = Math.max(84, Math.min(130, lane - 12));
    st.wave = {
      cardId: target.id, side,
      asteroids: opts.map((c, i) => ({
        key: `${Date.now()}-${c.id}`, cardId: c.id,
        x: lane * i + (lane - size) / 2 + (Math.random() - 0.5) * Math.max(0, lane - size) * 0.6,
        // Start just above the field, staggered so they arrive one after another.
        y: -size * 0.5 - Math.random() * size * 0.8,
        vx: (Math.random() - 0.5) * 10, spin: (Math.random() - 0.5) * 30, size,
        html: answerOf(c, side) || (c.image ? `<img src="${c.image.replace(/"/g, '&quot;')}" alt="">` : ''),
        state: 'live',
      })),
    };
  }, [cards, answerWith, choices]);

  const endGame = useCallback(() => {
    const st = g.current;
    setPhase('over');
    const newBest = best == null || st.score > best;
    if (newBest && st.score > 0) {
      setBest(st.score);
      quizlet.putState(deckId, 'blast', { best: st.score }).catch(() => {});
    }
    setResult({
      score: st.score, hits: st.hits, misses: st.misses, newBest: newBest && st.score > 0,
      review: [...st.missed.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 8),
    });
  }, [best, deckId]);

  const start = () => {
    g.current = {
      wave: null, score: 0, lives: LIVES, streak: 0, hits: 0, misses: 0,
      endAt: Date.now() + duration * 1000, last: performance.now(), now: Date.now(), speedMul: 1, missed: new Map(), message: '', messageUntil: 0, nextWaveAt: 0,
    };
    setResult(null);
    setView(null);
    setPhase('play');
  };

  // Game loop.
  useEffect(() => {
    if (phase !== 'play') return;
    if (!g.current.wave) spawnWave();
    let raf = 0;
    const loop = (t: number) => {
      const st = g.current;
      const dt = Math.min(0.05, (t - st.last) / 1000);
      st.last = t;
      st.now = Date.now();
      const { w, h } = fieldSize();
      if (st.wave) {
        for (const a of st.wave.asteroids) {
          if (a.state !== 'live') continue;
          a.y += SPEED_PX[speed] * st.speedMul * dt * (h / 440);
          a.x = Math.max(0, Math.min(w - a.size, a.x + a.vx * dt));
        }
        const target = st.wave.asteroids.find(a => a.cardId === st.wave!.cardId);
        if (target && target.state === 'live' && target.y > h) {
          // Let the right answer get away.
          st.lives -= 1;
          st.streak = 0;
          st.misses += 1;
          st.missed.set(st.wave.cardId, (st.missed.get(st.wave.cardId) ?? 0) + 1);
          quizlet.review(deckId, st.wave.cardId, 1).then(() => reviewed.current()).catch(() => {});
          st.message = `Missed! It was “${stripHtml(target.html).slice(0, 40)}”`;
          st.messageUntil = Date.now() + 1600;
          st.wave = null;
          st.nextWaveAt = Date.now() + 700;
        }
      } else if (Date.now() >= st.nextWaveAt) {
        spawnWave();
      }
      if (st.lives <= 0 || Date.now() >= st.endAt) { endGame(); return; }
      setView({
        wave: st.wave && { ...st.wave, asteroids: st.wave.asteroids.map(a => ({ ...a })) },
        score: st.score, lives: st.lives,
        remaining: Math.max(0, Math.ceil((st.endAt - st.now) / 1000)),
        message: st.now < st.messageUntil ? st.message : null,
      });
      raf = requestAnimationFrame(loop);
    };
    g.current.last = performance.now();
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, speed, spawnWave, endGame, deckId]);

  const blast = (key: string) => {
    const st = g.current;
    const a = st.wave?.asteroids.find(x => x.key === key);
    if (!st.wave || !a || a.state !== 'live') return;
    if (a.cardId === st.wave.cardId) {
      st.streak += 1;
      st.hits += 1;
      const mult = Math.min(5, 1 + Math.floor(st.streak / 3));
      st.score += POINTS * mult;
      st.speedMul = Math.min(1.8, st.speedMul + 0.03);
      st.wave.asteroids.forEach(x => { x.state = x === a ? 'boom' : 'hit'; });
      quizlet.review(deckId, st.wave.cardId, 2).then(() => reviewed.current()).catch(() => {});
      st.message = mult > 1 ? `+${POINTS * mult} · ${mult}× streak!` : `+${POINTS}`;
      st.messageUntil = Date.now() + 900;
      const done = st.wave;
      setTimeout(() => { if (g.current.wave === done) { g.current.wave = null; g.current.nextWaveAt = Date.now() + 250; } }, 350);
    } else {
      a.state = 'boom';
      st.streak = 0;
      st.score = Math.max(0, st.score - WRONG_POINTS);
      st.missed.set(st.wave.cardId, (st.missed.get(st.wave.cardId) ?? 0) + 1);
      st.message = `−${WRONG_POINTS}`;
      st.messageUntil = Date.now() + 700;
    }
  };

  // Number keys fire at asteroids left-to-right.
  useEffect(() => {
    if (phase !== 'play') return;
    const h = (e: KeyboardEvent) => {
      const n = Number(e.key);
      const wave = g.current.wave;
      if (!wave || !(n >= 1 && n <= 9)) return;
      const live = [...wave.asteroids].sort((a, b) => a.x - b.x);
      const a = live[n - 1];
      if (a) blast(a.key);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (cards.length < 3) {
    return <div className="card text-center py-12 text-(--text-secondary)">Blast needs at least 3 terms.</div>;
  }

  if (phase === 'start' || phase === 'over') {
    return (
      <div className="card space-y-6 py-8">
        {phase === 'over' && result ? (
          <div className="text-center space-y-2">
            <p className="text-xs uppercase tracking-wider text-(--text-secondary) font-semibold">Game over</p>
            <h2 className="text-2xl font-bold">{result.newBest ? 'New high score!' : 'Good game!'}</h2>
            <p className="text-5xl font-bold tabular-nums">{result.score.toLocaleString()}</p>
            <p className="text-sm text-(--text-secondary)">{result.hits} blasted · {result.misses} got away</p>
          </div>
        ) : (
          <div className="text-center space-y-3">
            <BlastIcon className="w-14 h-14 mx-auto" style={{ color: 'rgba(var(--accent-rgb), 0.6)' }} />
            <h2 className="text-2xl font-bold">Blast</h2>
            <p className="text-sm text-(--text-secondary) max-w-sm mx-auto">
              Answers fall as asteroids. Blast the one that matches the prompt. Wrong hits cost {WRONG_POINTS} points, and if the right one gets past you, you lose a life.
            </p>
          </div>
        )}
        {best != null && <p className="text-sm text-center text-(--text-secondary) flex items-center justify-center gap-1.5"><Trophy className="w-4 h-4 text-yellow-400" /> High score: <span className="text-white font-semibold">{best.toLocaleString()}</span></p>}
        {result && result.review.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-(--text-secondary) uppercase tracking-wider mb-2">Worth reviewing</p>
            <div className="space-y-1.5">
              {result.review.map(id => {
                const c = cards.find(x => x.id === id);
                return c && (
                  <div key={id} className="flex gap-3 rounded-lg px-3 py-2 text-sm bg-(--bg-tertiary)">
                    <Html html={c.front} className="flex-1 font-medium min-w-0" />
                    <div className="w-px bg-white/10" />
                    <Html html={c.back} className="flex-1 text-(--text-secondary) min-w-0" />
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 max-w-lg mx-auto text-sm">
          <label className="flex items-center justify-between gap-3">Speed
            <Segmented value={speed} onChange={setSpeed} options={[{ value: 'slow', label: 'Slow' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }]} /></label>
          <label className="flex items-center justify-between gap-3">Choices
            <Segmented value={String(choices)} onChange={v => setChoices(Number(v))} options={['3', '4', '5'].map(v => ({ value: v, label: v }))} /></label>
          <label className="flex items-center justify-between gap-3">Time
            <Segmented value={String(duration)} onChange={v => setDuration(Number(v))} options={[{ value: '60', label: '1m' }, { value: '120', label: '2m' }, { value: '180', label: '3m' }]} /></label>
          <label className="flex items-center justify-between gap-3">Blast the
            <Segmented value={answerWith} onChange={setAnswerWith} options={[{ value: 'definition', label: 'Def.' }, { value: 'term', label: 'Term' }, { value: 'both', label: 'Both' }]} /></label>
        </div>
        <div className="text-center">
          <button onClick={start} className="btn btn-primary px-10 inline-flex items-center gap-2">
            {phase === 'over' ? <><RotateCcw className="w-4 h-4" /> Play again</> : 'Start game'}
          </button>
        </div>
      </div>
    );
  }

  if (!view) return <div className="blast-field rounded-xl" style={{ height: 'clamp(22rem, 60vh, 32rem)' }} ref={fieldRef} />;
  const { wave, remaining } = view;
  const prompt = wave ? cards.find(c => c.id === wave.cardId) : null;
  const order = wave ? [...wave.asteroids].sort((a, b) => a.x - b.x).map(a => a.key) : [];

  return (
    <div className="space-y-3 select-none">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-1">
          {Array.from({ length: LIVES }, (_, i) => <Heart key={i} className={`w-5 h-5 ${i < view.lives ? 'fill-(--accent) text-(--accent)' : 'text-(--bg-tertiary)'}`} />)}
        </div>
        <span className="font-bold text-xl tabular-nums">{view.score.toLocaleString()}</span>
        <span className="tabular-nums text-(--text-secondary)">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
      </div>
      <div ref={fieldRef} className="blast-field relative rounded-xl overflow-hidden" style={{ height: 'clamp(22rem, 60vh, 32rem)' }}>
        {wave?.asteroids.map(a => (
          <button key={a.key} onClick={() => blast(a.key)}
            className={`blast-rock absolute flex items-center justify-center text-center p-3 ${a.state === 'boom' ? 'blast-boom' : a.state === 'hit' ? 'opacity-40' : ''} ${a.state === 'boom' && a.cardId !== wave.cardId ? 'blast-wrong' : ''}`}
            style={{ left: a.x, top: a.y, width: a.size, height: a.size, '--spin': `${a.spin}deg` } as React.CSSProperties}>
            <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[10px] text-white/40 font-bold">{order.indexOf(a.key) + 1}</span>
            <Html html={a.html} className={`relative ${stripHtml(a.html).length > 30 ? 'text-[11px]' : 'text-sm'} font-semibold leading-tight break-words max-w-full [&_img]:max-h-12`} />
          </button>
        ))}
        {view.message && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/50 text-sm font-semibold flex items-center gap-1.5 pointer-events-none">
            <Zap className="w-3.5 h-3.5 text-yellow-400" /> {view.message}
          </div>
        )}
      </div>
      <div className="card text-center" style={{ padding: '1rem' }}>
        <p className="text-[11px] uppercase tracking-wider text-(--text-secondary) mb-1">Blast the matching {wave?.side === 'term' ? 'term' : 'definition'}</p>
        {prompt && wave ? <Html html={promptOf(prompt, wave.side)} className="text-xl font-bold leading-snug" /> : <p className="text-xl font-bold opacity-30">…</p>}
      </div>
      <style>{`
        .blast-field {
          background:
            radial-gradient(1px 1px at 12% 18%, #fff8, transparent), radial-gradient(1px 1px at 72% 34%, #fff6, transparent),
            radial-gradient(1.5px 1.5px at 35% 72%, #fff7, transparent), radial-gradient(1px 1px at 88% 82%, #fff5, transparent),
            radial-gradient(1px 1px at 54% 10%, #fff6, transparent), radial-gradient(1.5px 1.5px at 22% 48%, #fff5, transparent),
            radial-gradient(ellipse at 50% 120%, rgba(var(--accent-rgb), 0.25), transparent 60%),
            #070b1a;
        }
        .blast-rock {
          border-radius: 46% 54% 42% 58% / 52% 44% 56% 48%;
          background: radial-gradient(circle at 32% 28%, #5b6475, #3a4150 55%, #252a35);
          box-shadow: inset -8px -10px 18px rgba(0,0,0,.45), inset 6px 6px 12px rgba(255,255,255,.08), 0 4px 18px rgba(0,0,0,.4);
          transform: rotate(var(--spin));
          transition: opacity .2s, transform .15s;
          cursor: crosshair;
        }
        .blast-rock > * { transform: rotate(calc(var(--spin) * -1)); }
        .blast-rock:hover { box-shadow: inset -8px -10px 18px rgba(0,0,0,.45), 0 0 0 2px rgba(var(--accent-rgb), .7), 0 4px 18px rgba(0,0,0,.4); }
        @keyframes blastBoom { 0% { transform: scale(1); opacity: 1; filter: brightness(1) } 40% { transform: scale(1.25); filter: brightness(2.2) } 100% { transform: scale(1.6); opacity: 0 } }
        .blast-boom { animation: blastBoom .35s ease-out forwards; pointer-events: none; background: radial-gradient(circle, #ffd27a, #ff7a3d 45%, #c8362c); }
        .blast-wrong { background: radial-gradient(circle, #ff9b9b, #c8362c 60%); }
      `}</style>
    </div>
  );
}
