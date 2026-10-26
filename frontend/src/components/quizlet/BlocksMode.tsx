import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trophy, RotateCcw, RefreshCw, Check, X } from 'lucide-react';
import BlocksIcon from '../../assets/icons/brand-blocks.svg?react';
import { quizlet, type QuizletCard } from '../../api';
import { answerOf, mcOptions, promptOf, resolveSide, sample, type Side } from './shared';
import { Html } from './ui';

/**
 * Blocks: place pieces on an 8×8 grid and clear full rows/columns. Once all three
 * pieces are placed, answer a question from the set to earn the next three.
 * The game ends when none of the pieces you hold fits anywhere.
 */

const N = 8;
type Shape = [number, number][]; // [row, col]

const SHAPES: Shape[] = [
  [[0, 0]],
  [[0, 0], [0, 1]], [[0, 0], [1, 0]],
  [[0, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [0, 1], [0, 2], [0, 3]], [[0, 0], [1, 0], [2, 0], [3, 0]],
  [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  [[0, 0], [0, 1], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 0], [1, 1]], [[0, 1], [1, 0], [1, 1]], [[0, 0], [0, 1], [1, 0]], [[0, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [2, 1]], [[0, 1], [1, 1], [2, 1], [2, 0]], [[0, 0], [0, 1], [0, 2], [1, 0]], [[0, 0], [0, 1], [0, 2], [1, 2]],
  [[0, 0], [0, 1], [0, 2], [1, 1]], [[0, 1], [1, 0], [1, 1], [1, 2]],
  [[0, 0], [0, 1], [1, 1], [1, 2]], [[0, 1], [0, 2], [1, 0], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]], [[0, 2], [1, 2], [2, 0], [2, 1], [2, 2]],
];
const COLORS = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6'];

interface Piece { id: string; shape: Shape; color: string; used: boolean }
type Grid = (string | null)[][];
interface BlocksSaved { best: number }

const emptyGrid = (): Grid => Array.from({ length: N }, () => Array<string | null>(N).fill(null));
const dims = (s: Shape) => ({ h: Math.max(...s.map(c => c[0])) + 1, w: Math.max(...s.map(c => c[1])) + 1 });

function fits(grid: Grid, s: Shape, r: number, c: number): boolean {
  return s.every(([dr, dc]) => {
    const rr = r + dr, cc = c + dc;
    return rr >= 0 && rr < N && cc >= 0 && cc < N && !grid[rr][cc];
  });
}

function fitsAnywhere(grid: Grid, s: Shape): boolean {
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (fits(grid, s, r, c)) return true;
  return false;
}

let pieceSeq = 0;
function newPieces(): Piece[] {
  return Array.from({ length: 3 }, () => ({ id: `p${pieceSeq++}`, shape: sample(SHAPES), color: sample(COLORS), used: false }));
}

interface Question { card: QuizletCard; side: Side; options: QuizletCard[] }

export function BlocksMode({ deckId, cards, onReviewed }: { deckId: number; cards: QuizletCard[]; onReviewed: () => void }) {
  const [phase, setPhase] = useState<'start' | 'play' | 'over'>('start');
  const [grid, setGrid] = useState<Grid>(emptyGrid);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [clearing, setClearing] = useState<Set<string>>(new Set());
  const [question, setQuestion] = useState<Question | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [qStats, setQStats] = useState({ right: 0, asked: 0 });
  const [best, setBest] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [drag, setDrag] = useState<{ pieceId: string; x: number; y: number; grabR: number; grabC: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cellPx, setCellPx] = useState(40);

  useEffect(() => {
    quizlet.getState<BlocksSaved>(deckId, 'blocks').then(r => { if (r.state) setBest(r.state.best); }).catch(() => {});
  }, [deckId]);

  useEffect(() => {
    const measure = () => { const w = gridRef.current?.getBoundingClientRect().width; if (w) setCellPx(w / N); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [phase]);

  const askQuestion = () => {
    const card = sample(cards);
    const side = resolveSide('definition');
    setQuestion({ card, side, options: mcOptions(card, cards, side, Math.min(4, cards.length)) });
    setPicked(null);
  };

  const start = () => {
    setGrid(emptyGrid());
    setPieces(newPieces());
    setScore(0);
    setLines(0);
    setQStats({ right: 0, asked: 0 });
    setQuestion(null);
    setSelected(null);
    setPhase('play');
  };

  const gameOver = (finalScore: number) => {
    setPhase('over');
    if (best == null || finalScore > best) {
      setBest(finalScore);
      quizlet.putState(deckId, 'blocks', { best: finalScore }).catch(() => {});
    }
  };

  const place = (pieceId: string, r: number, c: number) => {
    const piece = pieces.find(p => p.id === pieceId);
    if (!piece || piece.used || !fits(grid, piece.shape, r, c)) return false;
    const g = grid.map(row => [...row]);
    piece.shape.forEach(([dr, dc]) => { g[r + dr][c + dc] = piece.color; });

    const fullRows = [...Array(N).keys()].filter(i => g[i].every(Boolean));
    const fullCols = [...Array(N).keys()].filter(j => g.every(row => row[j]));
    const cleared = new Set<string>();
    fullRows.forEach(i => { for (let j = 0; j < N; j++) cleared.add(`${i},${j}`); });
    fullCols.forEach(j => { for (let i = 0; i < N; i++) cleared.add(`${i},${j}`); });
    const nLines = fullRows.length + fullCols.length;
    const gained = piece.shape.length + nLines * 10 * nLines;
    const nextScore = score + gained;

    const nextPieces = pieces.map(p => (p.id === pieceId ? { ...p, used: true } : p));
    setPieces(nextPieces);
    setScore(nextScore);
    setLines(l => l + nLines);
    setSelected(null);

    const after = g.map(row => [...row]);
    cleared.forEach(k => { const [i, j] = k.split(',').map(Number); after[i][j] = null; });

    if (cleared.size) {
      setGrid(g);
      setClearing(cleared);
      setTimeout(() => { setGrid(after); setClearing(new Set()); }, 260);
    } else {
      setGrid(after);
    }

    const remaining = nextPieces.filter(p => !p.used);
    if (remaining.length === 0) askQuestion();
    else if (!remaining.some(p => fitsAnywhere(after, p.shape))) setTimeout(() => gameOver(nextScore), 400);
    return true;
  };

  const answerQuestion = (opt: QuizletCard) => {
    if (!question || picked != null) return;
    const ok = opt.id === question.card.id;
    setPicked(opt.id);
    setQStats(s => ({ right: s.right + (ok ? 1 : 0), asked: s.asked + 1 }));
    quizlet.review(deckId, question.card.id, ok ? 2 : 1).then(onReviewed).catch(() => {});
    if (ok) {
      setTimeout(() => {
        const fresh = newPieces();
        setPieces(fresh);
        setQuestion(null);
        setScore(s => s + 20);
        if (!fresh.some(p => fitsAnywhere(grid, p.shape))) gameOver(score + 20);
      }, 700);
    }
  };

  // Pointer drag from the tray onto the grid. The piece floats above the finger so it stays visible.
  const LIFT = 56;
  const cellAt = (x: number, y: number, d: NonNullable<typeof drag>) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const c = Math.floor((x - rect.left) / cellPx) - d.grabC;
    const r = Math.floor((y - LIFT - rect.top) / cellPx) - d.grabR;
    return { r, c };
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag(d => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    const up = (e: PointerEvent) => {
      const at = cellAt(e.clientX, e.clientY, drag);
      if (at) place(drag.pieceId, at.r, at.c);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });

  const dragPiece = drag ? pieces.find(p => p.id === drag.pieceId) : null;
  const ghost = useMemo(() => {
    let piece: Piece | undefined | null = null, at: { r: number; c: number } | null = null;
    if (drag && dragPiece) { piece = dragPiece; at = cellAt(drag.x, drag.y, drag); }
    else if (selected && hover) { piece = pieces.find(p => p.id === selected); at = hover; }
    if (!piece || !at) return null;
    return { cells: new Set(piece.shape.map(([dr, dc]) => `${at!.r + dr},${at!.c + dc}`)), ok: fits(grid, piece.shape, at.r, at.c), color: piece.color };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, dragPiece, selected, hover, pieces, grid, cellPx]);

  if (cards.length < 2) {
    return <div className="card text-center py-12 text-(--text-secondary)">Blocks needs at least 2 terms.</div>;
  }

  if (phase !== 'play') {
    return (
      <div className="card text-center space-y-5 py-10">
        {phase === 'over' ? (
          <>
            <p className="text-xs uppercase tracking-wider text-(--text-secondary) font-semibold">No more moves</p>
            <h2 className="text-2xl font-bold">{best === score && score > 0 ? 'New high score!' : 'Game over'}</h2>
            <p className="text-5xl font-bold tabular-nums">{score.toLocaleString()}</p>
            <p className="text-sm text-(--text-secondary)">{lines} lines cleared · {qStats.right}/{qStats.asked} questions right</p>
          </>
        ) : (
          <>
            <BlocksIcon className="w-14 h-14 mx-auto" style={{ color: 'rgba(var(--accent-rgb), 0.6)' }} />
            <h2 className="text-2xl font-bold">Blocks</h2>
            <p className="text-sm text-(--text-secondary) max-w-sm mx-auto">
              Drag pieces onto the board to fill rows and columns. Placed all three? Answer a question to earn three more. The game ends when nothing fits.
            </p>
          </>
        )}
        {best != null && <p className="text-sm text-(--text-secondary) flex items-center justify-center gap-1.5"><Trophy className="w-4 h-4 text-yellow-400" /> High score: <span className="text-white font-semibold">{best.toLocaleString()}</span></p>}
        <button onClick={start} className="btn btn-primary px-10 inline-flex items-center gap-2">
          {phase === 'over' ? <><RotateCcw className="w-4 h-4" /> Play again</> : 'Start game'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 select-none touch-none">
      <div className="flex items-center justify-between">
        <span className="text-2xl font-bold tabular-nums">{score.toLocaleString()}</span>
        <span className="text-sm text-(--text-secondary)">{lines} lines</span>
        <button onClick={() => gameOver(score)} className="text-sm text-(--text-secondary) hover-accent">End game</button>
      </div>

      <div ref={gridRef} className="grid gap-[3px] p-[3px] rounded-xl bg-(--bg-tertiary) mx-auto w-full max-w-md aspect-square"
        style={{ gridTemplateColumns: `repeat(${N}, 1fr)` }}
        onMouseLeave={() => setHover(null)}>
        {grid.map((row, r) => row.map((color, c) => {
          const k = `${r},${c}`;
          const inGhost = ghost?.cells.has(k);
          return (
            <div key={k}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => { if (selected) place(selected, r, c); }}
              className={`rounded-[5px] transition-colors duration-100 ${clearing.has(k) ? 'blocks-clear' : ''}`}
              style={{
                background: color ?? (inGhost ? (ghost!.ok ? ghost!.color + '66' : 'rgba(248,113,113,.35)') : 'var(--bg-secondary)'),
                boxShadow: color ? 'inset 0 -3px 0 rgba(0,0,0,.25), inset 0 2px 0 rgba(255,255,255,.2)' : undefined,
              }} />
          );
        }))}
      </div>

      <div className="grid grid-cols-3 gap-2 max-w-md mx-auto">
        {pieces.map(p => {
          const { h, w } = dims(p.shape);
          const size = Math.min(22, 90 / Math.max(h, w));
          return (
            <div key={p.id}
              onPointerDown={e => {
                if (p.used || question) return;
                const rect = (e.currentTarget.firstElementChild as HTMLElement).getBoundingClientRect();
                const grabC = Math.max(0, Math.min(w - 1, Math.floor((e.clientX - rect.left) / size)));
                const grabR = Math.max(0, Math.min(h - 1, Math.floor((e.clientY - rect.top) / size)));
                setSelected(p.id);
                setDrag({ pieceId: p.id, x: e.clientX, y: e.clientY, grabR, grabC });
              }}
              className={`h-28 rounded-xl flex items-center justify-center transition-colors ${p.used ? 'opacity-0 pointer-events-none' : selected === p.id ? 'bg-(--accent)/10 ring-1 ring-(--accent)/50' : 'bg-(--bg-secondary)'} ${drag?.pieceId === p.id ? 'opacity-30' : ''} cursor-grab`}>
              <PieceView shape={p.shape} color={p.color} cell={size} />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-center text-(--text-secondary)">Drag a piece onto the board, or tap a piece and then a square.</p>

      {drag && dragPiece && createPortal(
        <div className="fixed pointer-events-none z-[300]" style={{ left: drag.x - drag.grabC * cellPx - cellPx / 2, top: drag.y - LIFT - drag.grabR * cellPx - cellPx / 2 }}>
          <PieceView shape={dragPiece.shape} color={dragPiece.color} cell={cellPx} gap={3} />
        </div>,
        document.body,
      )}

      {question && createPortal(
        <div className="fixed inset-0 z-[150] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-(--bg-secondary) rounded-xl max-w-lg w-full p-6 space-y-4 section-summary-in">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider text-(--text-secondary) font-semibold">Answer to earn 3 more pieces</p>
              <button onClick={askQuestion} disabled={picked != null} title="Try a different question" className="icon-btn disabled:opacity-30"><RefreshCw className="w-4 h-4" /></button>
            </div>
            <Html html={promptOf(question.card, question.side)} className="text-xl font-semibold leading-snug" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {question.options.map(o => {
                const right = o.id === question.card.id;
                const sel = picked === o.id;
                return (
                  <button key={o.id} disabled={picked != null} onClick={() => answerQuestion(o)}
                    className={`rounded-xl p-3 text-left text-sm font-medium transition-all flex gap-2 items-start ${
                      picked != null ? (right ? 'bg-green-500/15 ring-1 ring-green-500/60' : sel ? 'bg-red-500/15 ring-1 ring-red-500/60' : 'bg-(--bg-tertiary) opacity-40') : 'bg-(--bg-tertiary) hover:bg-white/8'}`}>
                    {picked != null && right && <Check className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />}
                    {sel && !right && <X className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />}
                    <Html html={answerOf(o, question.side)} className="min-w-0" />
                  </button>
                );
              })}
            </div>
            {picked != null && picked !== question.card.id && (
              <button onClick={askQuestion} className="btn btn-primary w-full">Try another question</button>
            )}
          </div>
        </div>,
        document.body,
      )}

      <style>{`
        @keyframes blocksClear { 0% { filter: brightness(1); transform: scale(1) } 50% { filter: brightness(2); transform: scale(1.08) } 100% { opacity: 0; transform: scale(.6) } }
        .blocks-clear { animation: blocksClear .26s ease-in forwards; }
      `}</style>
    </div>
  );
}

function PieceView({ shape, color, cell, gap = 2 }: { shape: Shape; color: string; cell: number; gap?: number }) {
  const { h, w } = dims(shape);
  const set = new Set(shape.map(([r, c]) => `${r},${c}`));
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${w}, ${cell - gap}px)`, gridTemplateRows: `repeat(${h}, ${cell - gap}px)`, gap }}>
      {Array.from({ length: h * w }, (_, i) => {
        const r = Math.floor(i / w), c = i % w;
        return <div key={i} className="rounded-[4px]" style={set.has(`${r},${c}`) ? { background: color, boxShadow: 'inset 0 -3px 0 rgba(0,0,0,.25), inset 0 2px 0 rgba(255,255,255,.2)' } : undefined} />;
      })}
    </div>
  );
}
