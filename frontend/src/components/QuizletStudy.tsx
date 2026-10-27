import { useState, useEffect, useRef, useCallback } from 'react';
import { sanitizeHtml } from '../sanitize';
import { createPortal } from 'react-dom';
import confetti from 'canvas-confetti';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Star, ChevronLeft, ChevronRight, ChevronDown,
  Undo2, Settings, X, Check,
  Play, Shuffle, Maximize2,
  TrendingUp, Lightbulb, BookOpen, Pencil,
} from 'lucide-react';
import { Flashcard, useFlashcard } from 'react-quizlet-flashcard';
import 'react-quizlet-flashcard/dist/index.css';
import FlashcardsIcon  from '../assets/icons/brand-flashcards.svg?react';
import LearnIcon       from '../assets/icons/brand-learn.svg?react';
import WriteIcon       from '../assets/icons/brand-write.svg?react';
import TestIcon       from '../assets/icons/brand-test.svg?react';
import BlocksIcon     from '../assets/icons/brand-blocks.svg?react';
import BlastIcon      from '../assets/icons/brand-blast.svg?react';
import MatchIcon      from '../assets/icons/brand-match.svg?react';
import { quizlet, studySessions, type QuizletCard } from '../api';
import { useSessionSaver } from '../hooks/useSessionSaver';
import { shuffle } from './quizlet/shared';
import { Toggle } from './quizlet/ui';
import { levels as learnLevelsOf, type Level, type LearnState } from './quizlet/learnEngine';
import { LearnMode } from './quizlet/LearnMode';
import { TestMode } from './quizlet/TestMode';
import { MatchMode } from './quizlet/MatchMode';
import { BlastMode } from './quizlet/BlastMode';
import { BlocksMode } from './quizlet/BlocksMode';

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

type StudyMode = 'flashcards' | 'learn' | 'write' | 'test' | 'blocks' | 'blast' | 'match';

interface FlashcardsSaved {
  queue: number[]; index: number; known: number[]; unknown: number[];
  trackProgress: boolean; isShuffled: boolean; frontSide: 'term' | 'definition'; studyStarredOnly: boolean;
}

const MODES: { id: StudyMode; label: string; Icon: typeof FlashcardsIcon; active: boolean }[] = [
  { id: 'flashcards', label: 'Flashcards', Icon: FlashcardsIcon, active: true },
  { id: 'learn',      label: 'Learn',      Icon: LearnIcon,      active: true },
  { id: 'test',       label: 'Test',       Icon: TestIcon,       active: true },
  { id: 'blocks',     label: 'Blocks',     Icon: BlocksIcon,     active: true },
  { id: 'blast',      label: 'Blast',      Icon: BlastIcon,      active: true },
  { id: 'match',      label: 'Match',      Icon: MatchIcon,      active: true },
];

// desktop: 3-col grid, icon left + label right
// mobile: rendered separately below progress bar as 2-col grid, icon+label stacked
/** Learn and Write share one tile; the chevron on its right switches between them. */
const LEARN_VARIANTS = {
  learn: { label: 'Learn', Icon: LearnIcon },
  write: { label: 'Write', Icon: WriteIcon },
} as const;

function ModeGrid({ mobile = false, activeMode = 'flashcards', onModeClick }: { mobile?: boolean; activeMode?: StudyMode; onModeClick?: (id: StudyMode) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const tileClass = (isCurrent: boolean, active = true) => `rounded-lg font-medium transition-colors ${
    mobile
      ? 'flex flex-col items-center justify-center gap-1.5 py-4 px-2 text-xs'
      : 'flex items-center gap-3 px-4 py-3 text-sm'
  } ${
    !active
      ? 'bg-(--bg-secondary) text-(--text-secondary) opacity-40 cursor-not-allowed'
      : isCurrent
      ? 'bg-(--accent)/10 text-(--accent)'
      : 'bg-(--bg-secondary) text-(--text-secondary) hover:bg-(--bg-tertiary) hover:text-white'
  }`;
  const iconClass = mobile ? 'w-8 h-8' : 'w-6 h-6';
  const iconStyle = { color: 'rgba(var(--accent-rgb), 0.55)' };

  return (
    <div className={mobile ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-3 gap-2'}>
      {MODES.map(({ id, label, Icon, active }) => {
        if (id === 'learn') {
          const shown = activeMode === 'write' ? 'write' : 'learn';
          const other = shown === 'learn' ? 'write' : 'learn';
          const { label: shownLabel, Icon: ShownIcon } = LEARN_VARIANTS[shown];
          const { label: otherLabel, Icon: OtherIcon } = LEARN_VARIANTS[other];
          const isCurrent = activeMode === 'learn' || activeMode === 'write';
          return (
            <div key={id} ref={menuRef} className="relative">
              <button onClick={() => onModeClick?.(shown)} className={`${tileClass(isCurrent)} w-full h-full ${mobile ? '' : 'pr-11'}`}>
                <ShownIcon className={iconClass} style={iconStyle} />
                {shownLabel}
              </button>
              <button
                onClick={() => setMenuOpen(o => !o)}
                aria-label="More Learn modes" aria-expanded={menuOpen}
                className={`absolute ${mobile ? 'top-1.5 right-1.5' : 'top-1/2 -translate-y-1/2 right-2'} w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                  isCurrent ? 'text-(--accent) hover:bg-(--accent)/15' : 'text-(--text-secondary) hover:text-white hover:bg-white/10'}`}>
                <ChevronDown className={`w-4 h-4 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
              </button>
              {menuOpen && (
                <div className="mode-menu-in absolute z-30 left-0 right-0 top-full mt-1.5 rounded-lg bg-(--bg-secondary) border border-white/8 shadow-xl p-1">
                  <button onClick={() => { setMenuOpen(false); onModeClick?.(other); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-(--text-secondary) hover:bg-(--bg-tertiary) hover:text-white transition-colors">
                    <OtherIcon className="w-5 h-5" style={iconStyle} />
                    <span className="flex-1 text-left">{otherLabel}</span>
                    {other === 'write' && <span className="text-[11px] text-(--text-secondary)">type every answer</span>}
                  </button>
                </div>
              )}
            </div>
          );
        }
        const isCurrent = id === activeMode;
        return (
          <button
            key={id}
            disabled={!active}
            onClick={active ? () => onModeClick?.(id) : undefined}
            title={active ? undefined : 'Coming soon'}
            className={tileClass(isCurrent, active)}
          >
            <Icon className={iconClass} style={active ? iconStyle : undefined} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

interface EndScreenProps {
  title: string; total: number; known: Set<number>; unknown: Set<number>;
  onRestart: () => void; onRestartUnknown: () => void; onBack: () => void; onMode: (m: StudyMode) => void;
}

function EndScreen({ title, total, known, unknown, onRestart, onRestartUnknown, onBack, onMode }: EndScreenProps) {
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
      <ModeGrid onModeClick={onMode} />
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
                <button className="btn btn-primary w-full flex items-center justify-center gap-2" onClick={() => onMode('learn')}>
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
  const [brokenImages, setBrokenImages] = useState<Set<number>>(new Set());
  const markImageBroken = (id: number) => setBrokenImages(prev => new Set([...prev, id]));

  const [trackProgress, setTrackProgress] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const [unknown, setUnknown] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<Array<{ cardId: number; wasKnown: boolean }>>([]);
  const [sessionDone, setSessionDone] = useState(false);

  const [feedback, setFeedback] = useState<'known' | 'unknown' | null>(null);

  // Swipe-to-dismiss drag state (mobile only)
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [dragSnapping, setDragSnapping] = useState(false);
  const [dragFlying, setDragFlying] = useState<'left' | 'right' | null>(null);
  const swipeRef = useRef<{ startX: number; startY: number; active: boolean }>({ startX: 0, startY: 0, active: false });
  const cardTouchRef = useRef<HTMLDivElement>(null);
  const SWIPE_THRESHOLD = 72;

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
  const [editImageDrag, setEditImageDrag] = useState(false);
  const frontEditRef = useRef<HTMLDivElement>(null);
  const backEditRef = useRef<HTMLDivElement>(null);
  const editImageInputRef = useRef<HTMLInputElement>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = useState<StudyMode>(() => {
    const m = searchParams.get('mode');
    return MODES.some(x => x.id === m) || m === 'write' ? (m as StudyMode) : 'flashcards';
  });
  const [learnLevels, setLearnLevels] = useState<Map<number, Level>>(new Map());

  const fcSessionExists = useRef(false);
  const current = queue[index];

  useEffect(() => {
    Promise.all([
      quizlet.getDeck(deckId), quizlet.deckStats(deckId), quizlet.getFavorites(deckId),
      studySessions.get<FlashcardsSaved>('quizlet-flashcards', deckId).catch(() => ({ session: null })),
    ]).then(([deck, stats, favs, fc]) => {
      setTitle(deck.title);
      setCards(deck.cards);
      setStudiedToday(stats.studied_today);
      setFavorites(new Set(favs.card_ids));
      // Pick up where the last flashcards session left off.
      const saved = fc.session?.status === 'active' ? fc.session.state : null;
      if (saved) {
        const byId = new Map(deck.cards.map(c => [c.id, c]));
        const restored = saved.queue.map(id => byId.get(id)).filter((c): c is QuizletCard => !!c);
        const missing = saved.studyStarredOnly ? [] : deck.cards.filter(c => !saved.queue.includes(c.id));
        const q = [...restored, ...missing];
        const i = Math.min(saved.index, Math.max(0, q.length - 1));
        setQueue(q);
        setIndex(i);
        prevIndexRef.current = i;
        trackProgressIndexRef.current = i;
        setKnown(new Set(saved.known.filter(id => byId.has(id))));
        setUnknown(new Set(saved.unknown.filter(id => byId.has(id))));
        setTrackProgress(saved.trackProgress);
        setIsShuffled(saved.isShuffled);
        setFrontSide(saved.frontSide);
        setStudyStarredOnly(saved.studyStarredOnly);
        fcSessionExists.current = true;
      } else {
        setQueue(deck.cards);
      }
      setLoading(false);
    });
    // Learn progress drives the "Still learning / Mastered" labels in the term list.
    studySessions.get<LearnState>('quizlet-learn', deckId)
      .then(r => { if (r.session?.state?.order) setLearnLevels(learnLevelsOf(r.session.state)); })
      .catch(() => {});
  }, [deckId]);

  // Save the flashcards session so it can be resumed from the Study hub.
  const fcSession = useSessionSaver('quizlet-flashcards', deckId);
  useEffect(() => {
    if (loading || !title) return;
    const started = index > 0 || known.size > 0 || unknown.size > 0;
    if (sessionDone || !started) {
      // Finished, or back at the very start: nothing to resume.
      if (sessionDone || fcSessionExists.current) fcSession.remove();
      fcSessionExists.current = false;
      return;
    }
    fcSessionExists.current = true;
    const state: FlashcardsSaved = {
      queue: queue.map(c => c.id), index, known: [...known], unknown: [...unknown],
      trackProgress, isShuffled, frontSide, studyStarredOnly,
    };
    fcSession.save({
      title,
      detail: trackProgress ? `${known.size} known · ${unknown.size} still learning` : `Card ${index + 1} of ${queue.length}`,
      progress_done: trackProgress ? known.size + unknown.size : index + 1,
      progress_total: queue.length,
      state,
    });
  }, [loading, title, queue, index, known, unknown, trackProgress, isShuffled, frontSide, studyStarredOnly, sessionDone, fcSession]);

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

  // Reset drag when card changes
  useEffect(() => {
    setDragX(0); setDragY(0); setDragSnapping(false); setDragFlying(null);
    swipeRef.current.active = false;
  }, [index]);

  // Keep a live ref so native event handlers always see current state
  const swipeLiveRef = useRef({ feedback, index, trackProgress, current: null as QuizletCard | null, queueLen: 0, advance });
  swipeLiveRef.current = { feedback, index, trackProgress, current, queueLen: queue.length, advance };

  const dragXRef = useRef(0);
  const dragYRef = useRef(0);

  useEffect(() => {
    const el = cardTouchRef.current;
    if (!el) return;
    const lv = () => swipeLiveRef.current;
    let startX = 0, startY = 0, active = false;

    const onStart = (e: TouchEvent) => {
      if (lv().feedback) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      active = true;
      dragXRef.current = 0; dragYRef.current = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // Only prevent default (block page scroll) once clearly dragging the card
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) e.preventDefault();
      dragXRef.current = dx; dragYRef.current = dy;
      setDragX(dx); setDragY(dy);
    };

    const onEnd = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      const dx = dragXRef.current;
      const dy = dragYRef.current;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) e.preventDefault();

      if (Math.abs(dx) >= 72) {
        const dir = dx > 0 ? 'right' : 'left';
        setDragFlying(dir);
        const { current: cap, index: capIdx, trackProgress: capTP, queueLen: capQL, advance: capAdv } = lv();
        setTimeout(() => {
          setDragX(0); setDragY(0); dragXRef.current = 0; dragYRef.current = 0; setDragFlying(null);
          if (!cap) return;
          if (capTP) {
            const isKnown = dir === 'right';
            quizlet.review(deckId, cap.id, isKnown ? 2 : 1);
            setStudiedToday(t => t + 1);
            setHistory(prev => [...prev, { cardId: cap.id, wasKnown: isKnown }]);
            if (isKnown) setKnown(prev => new Set([...prev, cap.id]));
            else setUnknown(prev => new Set([...prev, cap.id]));
            if (capIdx >= capQL - 1) setSessionDone(true);
            else capAdv(capIdx + 1);
          } else {
            if (capIdx < capQL - 1) capAdv(capIdx + 1);
          }
        }, 230);
      } else {
        // Snap back with spring animation
        dragXRef.current = 0; dragYRef.current = 0;
        setDragSnapping(true);
        setDragX(0); setDragY(0);
        setTimeout(() => setDragSnapping(false), 400);
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [mode, loading]);

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

  const loadImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => setEditImageUrl(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (!editingCard) return;
    if (frontEditRef.current) frontEditRef.current.innerHTML = sanitizeHtml(editingCard.front);
    if (backEditRef.current) backEditRef.current.innerHTML = sanitizeHtml(editingCard.back);
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

  // Keyboard shortcuts — ref keeps handler fresh without re-registering the listener
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (mode !== 'flashcards') return;
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


  const onReviewed = useCallback(() => setStudiedToday(t => t + 1), []);
  const openMode = useCallback((m: StudyMode) => {
    setMode(m);
    // Keep the mode in the URL so reloads and Study-hub links land in the right place.
    setSearchParams(m === 'flashcards' ? {} : { mode: m }, { replace: true });
    setSessionDone(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setSearchParams]);

  // From the Learn options toggle: switch Learn <-> Write without scrolling away.
  const setLearnVariant = useCallback((write: boolean) => {
    const m: StudyMode = write ? 'write' : 'learn';
    setMode(m);
    setSearchParams({ mode: m }, { replace: true });
  }, [setSearchParams]);

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

  if (mode === 'flashcards' && sessionDone && trackProgress) {
    return (
      <EndScreen title={title} total={queue.length} known={known} unknown={unknown}
        onRestart={() => restart()} onBack={() => navigate('/')}
        onRestartUnknown={() => restart(cards.filter(c => unknown.has(c.id)))} onMode={openMode} />
    );
  }

  if (mode === 'flashcards' && sessionDone && !trackProgress) {
    return (
      <EndScreen title={title} total={queue.length}
        known={new Set<number>(queue.map(c => c.id))} unknown={new Set<number>()}
        onRestart={() => restart()} onBack={() => navigate('/')}
        onRestartUnknown={() => {}} onMode={openMode} />
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
    const hasImage = showingTerm && !!current?.image && !brokenImages.has(current.id);
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
              <div className="text-2xl font-medium leading-snug text-center" dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }} />
            </div>
            <div className="flex-1 p-4">
              <img src={current!.image!} alt="" className="w-full h-full object-contain rounded-lg"
                onError={() => markImageBroken(current!.id)} />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 py-4 min-h-0">
            <div className="text-2xl font-medium leading-snug text-center w-full" dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }} />
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
        <ModeGrid activeMode={mode} onModeClick={openMode} />
      </div>

      {/* ── FLASHCARD mode ── */}
      {mode === 'flashcards' && (<>
        {/* Card with 3D flip + slide-in */}
        <div ref={cardTouchRef} style={{ perspective: '1100px', position: 'relative', zIndex: (dragX !== 0 || dragY !== 0 || !!dragFlying || dragSnapping) ? 50 : undefined }}>
          {/* Drag/fly wrapper — sits outside key={index} so transform doesn't conflict with slide-in */}
          <div style={
            dragFlying
              ? { transform: `translateX(${dragFlying === 'right' ? '160%' : '-160%'}) rotate(${dragFlying === 'right' ? 20 : -20}deg)`, opacity: 0, transition: 'transform 0.23s ease-in, opacity 0.2s ease-in', pointerEvents: 'none' }
              : dragSnapping
              ? { transform: 'translateX(0px) translateY(0px) rotate(0deg)', transition: 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)' }
              : (dragX !== 0 || dragY !== 0)
              ? { transform: `translateX(${dragX}px) translateY(${dragY}px) rotate(${dragX * 0.05}deg)`, transition: 'none' }
              : {}
          }>
            <div
              key={index}
              className={`relative ${
                feedback
                  ? (feedback === 'unknown' ? 'card-swipe-left' : 'card-swipe-right')
                  : (slideDir === 'right' ? 'card-slide-right' : 'card-slide-left')
              }`}
            >
              {/* Drag hint overlay — only shown when track progress is on */}
              {(dragX !== 0 || dragY !== 0) && !feedback && trackProgress && (
                <div className="absolute inset-0 z-10 rounded-xl overflow-hidden pointer-events-none flex items-center justify-center">
                  <div
                    className={`absolute inset-0 ${dragX > 0 ? 'bg-green-500/25' : 'bg-orange-500/25'}`}
                    style={{ opacity: Math.min(Math.abs(dragX) / SWIPE_THRESHOLD, 1) }}
                  />
                  <span
                    className={`relative z-10 text-4xl font-bold ${dragX > 0 ? 'text-green-400' : 'text-orange-400'}`}
                    style={{ opacity: Math.min(Math.abs(dragX) / SWIPE_THRESHOLD, 1) }}
                  >
                    {dragX > 0 ? 'Got it!' : 'Still learning'}
                  </span>
                </div>
              )}
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
            <div className="flex items-center gap-2 text-sm shrink-0 sm:order-1">
              <button onClick={toggleTrackProgress} className={`transition-colors ${trackProgress ? 'text-(--accent)' : 'text-(--text-secondary) hover:text-white'}`}>Track progress</button>
              <Toggle on={trackProgress} onChange={() => toggleTrackProgress()} />
            </div>
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
              <button className="icon-btn" title="Options" onClick={() => setShowOptions(true)}>
                <Settings className="w-4 h-4" />
              </button>
              <button className="icon-btn" title="Fullscreen (coming soon)">
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>

        </div>

        {/* Progress bar */}
        <div className="w-full bg-(--bg-tertiary) rounded-full h-1 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%`, background: 'var(--accent)' }} />
        </div>
      </>)}

      {(mode === 'learn' || mode === 'write') && (
        <LearnMode deckId={deckId} title={title} cards={cards} favorites={favorites} onReviewed={onReviewed}
          onLevels={setLearnLevels} onOpenMode={openMode}
          write={mode === 'write'} onWriteChange={setLearnVariant} />
      )}
      {mode === 'test' && <TestMode deckId={deckId} title={title} cards={cards} favorites={favorites} onReviewed={onReviewed} onOpenMode={openMode} />}
      {mode === 'match' && <MatchMode deckId={deckId} cards={cards} onReviewed={onReviewed} />}
      {mode === 'blast' && <BlastMode deckId={deckId} cards={cards} onReviewed={onReviewed} />}
      {mode === 'blocks' && <BlocksMode deckId={deckId} cards={cards} onReviewed={onReviewed} />}

      {/* Mobile mode grid */}
      <div className="block sm:hidden">
        <ModeGrid mobile activeMode={mode} onModeClick={openMode} />
      </div>

      {/* Card list */}
      {(mode === 'flashcards' || mode === 'learn' || mode === 'write') && (() => {
        // Learn progress wins; flashcard "Track progress" marks fill in for terms Learn hasn't touched.
        const statusOf = (id: number): 'mastered' | 'familiar' | 'learning' | null => {
          const lvl = learnLevels.get(id) ?? 0;
          if (lvl === 3) return 'mastered';
          if (lvl === 2) return 'familiar';
          if (lvl === 1) return 'learning';
          return known.has(id) ? 'mastered' : unknown.has(id) ? 'learning' : null;
        };
        const learningCount = cards.filter(c => { const st = statusOf(c.id); return st === 'learning' || st === 'familiar'; }).length;
        const masteredCount = cards.filter(c => statusOf(c.id) === 'mastered').length;
        let filtered = cards;
        if (listFilter === 'favorites') filtered = filtered.filter(c => favorites.has(c.id));
        else if (listFilter === 'learning') filtered = filtered.filter(c => { const st = statusOf(c.id); return st === 'learning' || st === 'familiar'; });
        else if (listFilter === 'mastered') filtered = filtered.filter(c => statusOf(c.id) === 'mastered');
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
                <span className="text-sm font-semibold text-orange-400 shrink-0">{learningCount} still learning</span>
              ) : listFilter === 'mastered' ? (
                <span className="text-sm font-semibold text-green-400 shrink-0">{masteredCount} mastered</span>
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
                className="input flex-1 min-w-0"
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
                const status = statusOf(card.id);
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
                        <div className="text-sm font-medium leading-snug flex-1 flex items-center" dangerouslySetInnerHTML={{ __html: sanitizeHtml(card.front) }} />
                      </div>
                      {/* Right: DEFINITION + image */}
                      <div className="flex-1 flex flex-col p-3 pr-16">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-secondary)">Definition</span>
                          {status === 'mastered' && <span className="text-[10px] font-semibold text-green-400 ml-auto">Mastered</span>}
                          {status === 'familiar' && <span className="text-[10px] font-semibold text-(--accent) ml-auto">Familiar</span>}
                          {status === 'learning' && <span className="text-[10px] font-semibold text-orange-400 ml-auto">Learning</span>}
                        </div>
                        <div className="flex-1 flex gap-2 min-h-0 items-center">
                          <div className="text-sm leading-snug flex-1" dangerouslySetInnerHTML={{ __html: sanitizeHtml(card.back) }} />
                          {card.image && !brokenImages.has(card.id) && (
                            <img
                              src={card.image} alt=""
                              className="shrink-0 rounded object-contain cursor-zoom-in hover:opacity-85 transition-opacity"
                              style={{ width: '56px', height: '56px' }}
                              onError={() => markImageBroken(card.id)}
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
      {showOptions && createPortal(
        // Animates its own slide-out (data-no-exit: no second exit animation from MotionLayer).
        <div data-no-exit className="fixed inset-0 z-[100] flex justify-end bg-black/50 transition-opacity duration-200"
          style={{ opacity: closingOptions ? 0 : 1 }} onClick={closeOptions}>
          <div
            className={`${closingOptions ? 'options-panel-closing' : 'options-panel'} bg-(--bg-secondary) border-l border-(--bg-tertiary) w-full max-w-sm h-screen overflow-y-auto shadow-2xl flex flex-col divide-y divide-white/8`}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 shrink-0" style={{ paddingTop: 'calc(1.5rem + var(--safe-top, env(safe-area-inset-top, 0px)))' }}>
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
              <Toggle on={trackProgress} onChange={() => toggleTrackProgress()} />
            </div>

            {/* Study only starred terms */}
            <div className="p-6 flex items-center justify-between gap-4">
              <div>
                <p className={`font-medium text-sm ${favorites.size === 0 ? 'text-(--text-secondary)' : ''}`}>Study only starred terms</p>
                {favorites.size === 0 && <p className="text-xs text-(--text-secondary) mt-0.5">Star some cards first.</p>}
              </div>
              <Toggle on={studyStarredOnly} disabled={favorites.size === 0} onChange={() => favorites.size > 0 && toggleStudyStarred(favorites)} />
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
            <div className="p-6" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom, env(safe-area-inset-bottom, 0px)))' }}>
              <button
                className="text-sm text-(--accent) font-medium hover-underline"
                onClick={() => { restart(); closeOptions(); }}
              >
                Restart Flashcards
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Edit Card Modal */}
      {editingCard && createPortal(
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
                <input
                  ref={editImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) loadImageFile(f); e.target.value = ''; }}
                />
                {editImageUrl ? (
                  <div className="flex items-center gap-3 p-2 bg-(--bg-tertiary) rounded-lg">
                    <img src={editImageUrl} alt="" className="w-14 h-14 object-contain rounded shrink-0" />
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-xs text-(--text-secondary)">Image attached</p>
                      <button
                        onClick={() => editImageInputRef.current?.click()}
                        className="text-xs text-(--accent) hover:underline"
                      >Replace</button>
                    </div>
                    <button onClick={() => setEditImageUrl('')} className="icon-btn icon-btn-danger shrink-0"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <div
                    onClick={() => editImageInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setEditImageDrag(true); }}
                    onDragLeave={() => setEditImageDrag(false)}
                    onDrop={e => { e.preventDefault(); setEditImageDrag(false); const f = e.dataTransfer.files[0]; if (f) loadImageFile(f); }}
                    className={`flex flex-col items-center justify-center gap-1.5 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-sm ${editImageDrag ? 'border-(--accent) bg-(--accent)/5' : 'border-(--bg-tertiary) text-(--text-secondary) hover:border-(--accent)/50'}`}
                  >
                    Drop image or click to upload
                  </div>
                )}
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
        </div>,
        document.body
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

        /* Learn / Write dropdown */
        @keyframes modeMenuIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        .mode-menu-in { animation: modeMenuIn 0.15s ease-out; }

        /* Phase bar slide-in when window advances */
        @keyframes phaseBarSlideIn {
          from { transform: translateX(28px); opacity: 0.5; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        .phase-bar-slide-in { animation: phaseBarSlideIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards; }

        /* Section summary slide-in */
        @keyframes sectionSummaryIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .section-summary-in { animation: sectionSummaryIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
      `}</style>
    </div>
  );
}
