import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Undo2, Volume2, PartyPopper, Loader2, AlertTriangle } from 'lucide-react';
import { decks, review, type ReviewCard, type ReviewState } from '../api';
import { useSessionSaver } from '../hooks/useSessionSaver';
import { StudyHub } from './StudyHub';
import { CardFrame } from './study/CardFrame';
import { mediaUrl } from './study/media';

/** Again / Hard / Good / Easy — same colors as the stats page. */
const BUTTONS: Record<number, { label: string; color: string }> = {
  1: { label: 'Again', color: '#e66767' },
  2: { label: 'Hard', color: '#9085e9' },
  3: { label: 'Good', color: '#008300' },
  4: { label: 'Easy', color: '#3987e5' },
};

const soundsIn = (s: string) => [...s.matchAll(/\[sound:([^\]]+)\]/g)].map(m => m[1]);

/** Audio files in field order — Anki's [anki:play:q:N] numbers them in that order. */
function cardSounds(card: ReviewCard): string[] {
  const fromHtml = soundsIn(card.question + card.answer);
  const fromFields = card.fields.flatMap(f => soundsIn(f.value));
  return [...new Set([...fromFields, ...fromHtml])];
}

export function Study() {
  const { id } = useParams<{ id?: string }>();
  if (!id) return <StudyHub />;
  return <Reviewer key={id} deckId={Number(id)} />;
}

function Reviewer({ deckId }: { deckId: number }) {
  const [deck, setDeck] = useState<string | null>(null);
  const [state, setState] = useState<ReviewState | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [flash, setFlash] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);

  // Deck name from its id (names only — cheap).
  useEffect(() => {
    decks.names().then(d => {
      const name = Object.entries(d.decks).find(([, v]) => v === deckId)?.[0];
      if (name) setDeck(name); else setError('This deck no longer exists.');
    }).catch(e => setError(e instanceof Error ? e.message : 'Could not reach Anki'));
  }, [deckId]);

  const load = useCallback((name: string) => {
    review.current(name).then(s => { setState(s); setRevealed(false); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load the deck'));
  }, []);
  useEffect(() => { if (deck) load(deck); }, [deck, load]);

  const card = state?.card ?? null;
  const sounds = useMemo(() => (card ? cardSounds(card) : []), [card]);
  const qSoundCount = useMemo(() => {
    if (!card) return 0;
    const idx = [...card.question.matchAll(/\[anki:play:q:(\d+)\]/g)].map(m => Number(m[1]));
    return idx.length ? Math.max(...idx) + 1 : soundsIn(card.question).length;
  }, [card]);

  // --- audio --------------------------------------------------------------------------
  const stopAudio = () => { queueRef.current = []; audioRef.current?.pause(); audioRef.current = null; };
  const token = state?.media_token ?? '';
  const playQueue = useCallback((files: string[]) => {
    stopAudio();
    if (!token || !files.length) return;
    queueRef.current = [...files];
    const next = () => {
      const f = queueRef.current.shift();
      if (!f) return;
      const a = new Audio(mediaUrl(f, token));
      audioRef.current = a;
      a.onended = next; a.onerror = next;
      a.play().catch(next);
    };
    next();
  }, [token]);

  // Autoplay: question audio when a card appears, the answer's own audio on reveal (like Anki).
  useEffect(() => { if (card) playQueue(sounds.slice(0, qSoundCount)); return stopAudio; }, [card, sounds, qSoundCount, playQueue]);

  // --- actions ------------------------------------------------------------------------
  const reveal = useCallback(() => {
    if (!card || revealed) return;
    setRevealed(true);
    playQueue(sounds.slice(qSoundCount));
  }, [card, revealed, playQueue, sounds, qSoundCount]);

  const answer = useCallback(async (ease: number) => {
    if (!card || !deck || !revealed || busy) return;
    setBusy(true);
    setFlash(ease);
    stopAudio();
    try {
      const next = await review.answer(deck, card.card_id, ease);
      setReviewed(n => n + 1);
      setState(next);
      setRevealed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the answer');
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 250);
    }
  }, [card, deck, revealed, busy]);

  const undo = useCallback(async () => {
    if (!deck || busy || reviewed === 0) return;
    setBusy(true);
    try {
      const s = await review.undo(deck);
      setState(s); setRevealed(false); setReviewed(n => Math.max(0, n - 1));
    } catch { /* nothing to undo */ } finally { setBusy(false); }
  }, [deck, busy, reviewed]);

  const onKey = useCallback((k: { key: string; ctrl: boolean }) => {
    if (k.ctrl && (k.key === 'z' || k.key === 'Z')) { undo(); return; }
    if (k.key === ' ' || k.key === 'Enter') { if (!revealed) reveal(); else answer(3); return; }
    if (revealed && ['1', '2', '3', '4'].includes(k.key)) { answer(Number(k.key)); return; }
    if (k.key === 'r' || k.key === 'R') playQueue(revealed ? sounds : sounds.slice(0, qSoundCount));
  }, [revealed, reveal, answer, undo, playQueue, sounds, qSoundCount]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
      if ([' ', 'Enter', '1', '2', '3', '4'].includes(e.key)) e.preventDefault();
      onKey({ key: e.key, ctrl: e.ctrlKey || e.metaKey });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onKey]);

  // Progress for the Study hub.
  const session = useSessionSaver('anki', deckId);
  useEffect(() => {
    if (!deck || !state) return;
    if (!state.card) { session.remove(); return; }
    if (reviewed === 0) return;
    const left = state.counts.new + state.counts.learn + state.counts.review;
    session.save({ title: deck, detail: `${left} left`, progress_done: reviewed, progress_total: reviewed + left });
  }, [deck, state, reviewed, session]);

  // --- render ---------------------------------------------------------------------------
  const crumbs = deck?.split('::') ?? [];
  const header = (
    <div className="flex items-center gap-3">
      <Link to="/" className="icon-btn shrink-0" title="Back to decks"><ArrowLeft className="w-4 h-4" /></Link>
      <div className="min-w-0 flex-1">
        {crumbs.length > 1 && <p className="text-[11px] text-(--text-secondary) truncate">{crumbs.slice(0, -1).join(' › ')}</p>}
        <p className="font-semibold truncate">{crumbs[crumbs.length - 1] ?? '…'}</p>
      </div>
      {state && (
        <div className="flex items-center gap-2.5 text-sm font-semibold tabular-nums" title="New · Learning · Review">
          <span style={{ color: '#3987e5' }}>{state.counts.new}</span>
          <span style={{ color: '#e66767' }}>{state.counts.learn}</span>
          <span style={{ color: '#199e70' }}>{state.counts.review}</span>
        </div>
      )}
      <button onClick={undo} disabled={!reviewed || busy} title="Undo (Ctrl+Z)" className="icon-btn shrink-0 disabled:opacity-30"><Undo2 className="w-4 h-4" /></button>
    </div>
  );

  if (error) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        {header}
        <div className="card text-center space-y-3 py-10 anim-pop">
          <AlertTriangle className="w-8 h-8 mx-auto text-(--warning)" />
          <p>{error}</p>
          {deck && <button onClick={() => load(deck)} className="btn btn-primary">Try again</button>}
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        {header}
        <div className="card flex items-center justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-(--text-secondary)" /></div>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        {header}
        <div className="card text-center space-y-4 py-14 anim-pop">
          <PartyPopper className="w-10 h-10 mx-auto text-(--accent)" />
          <div>
            <h2 className="text-xl font-bold">Congratulations! You’ve finished this deck for now.</h2>
            <p className="text-sm text-(--text-secondary) mt-1">
              {reviewed ? `${reviewed} ${reviewed === 1 ? 'card' : 'cards'} reviewed this session. ` : ''}New cards and reviews come back tomorrow.
            </p>
          </div>
          <div className="flex justify-center gap-2">
            <Link to="/" className="btn btn-primary">Back to decks</Link>
            <Link to="/study" className="btn btn-secondary">Study hub</Link>
          </div>
        </div>
      </div>
    );
  }

  const labels = card.next_reviews;
  return (
    <div className="max-w-2xl mx-auto space-y-4 pb-28 sm:pb-6">
      {header}

      <div key={card.card_id} className="card !p-0 overflow-hidden relative anim-card transition-shadow duration-200"
        style={flash ? { boxShadow: `0 0 0 2px ${BUTTONS[flash].color}` } : undefined}>
        <CardFrame html={revealed ? card.answer : card.question} css={card.css} token={state.media_token}
          side={revealed ? 'a' : 'q'} events={{
            onTap: () => { if (!revealed) reveal(); },
            onKey,
            onPlay: (i, side) => { const f = sounds[i]; if (f) playQueue([f]); else if (side === 'q') playQueue(sounds.slice(0, qSoundCount)); },
          }} />
        {sounds.length > 0 && (
          <button onClick={() => playQueue(revealed ? sounds : sounds.slice(0, qSoundCount))} title="Replay audio (R)"
            className="absolute top-3 right-3 icon-btn"><Volume2 className="w-4 h-4" /></button>
        )}
        {busy && <div className="absolute inset-0 bg-(--bg-secondary)/40 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>}
      </div>

      {/* Answer bar — pinned above the tab bar on phones */}
      <div className="fixed sm:static bottom-16 left-0 right-0 px-4 sm:px-0 pt-3 sm:pt-0 pb-3 sm:pb-0 z-30 bg-(--bg-primary)/95 sm:bg-transparent backdrop-blur sm:backdrop-blur-none">
        {!revealed ? (
          <button onClick={reveal} className="btn btn-primary w-full h-14 text-base font-semibold">
            Show answer <span className="opacity-60 text-xs ml-1.5 hidden sm:inline">Space</span>
          </button>
        ) : (
          <div className="grid gap-2 anim-rise" style={{ gridTemplateColumns: `repeat(${card.buttons.length}, minmax(0,1fr))` }}>
            {card.buttons.map((ease, i) => {
              const b = BUTTONS[ease] ?? BUTTONS[3];
              return (
                <button key={ease} onClick={() => answer(ease)} disabled={busy}
                  className="h-14 rounded-xl flex flex-col items-center justify-center gap-0.5 font-semibold text-sm bg-(--bg-secondary) hover:brightness-125 active:scale-[0.97] transition disabled:opacity-60"
                  style={{ boxShadow: `inset 0 -3px 0 ${b.color}` }}>
                  <span>{b.label}</span>
                  <span className="text-[11px] font-normal text-(--text-secondary) tabular-nums">{labels[i] ?? ''}<span className="hidden sm:inline opacity-60">{labels[i] ? ' · ' : ''}{ease}</span></span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {state.mode === 'legacy' && (
        <p className="text-[11px] text-(--text-secondary) text-center">Anki’s reviewer isn’t available, so cards are picked by due date (daily limits aren’t applied).</p>
      )}
    </div>
  );
}
