import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { X, Layers, BookOpen, Plus, Clock, ArrowRight, PlayCircle } from 'lucide-react';
import FlashcardsIcon from '../assets/icons/brand-flashcards.svg?react';
import LearnIcon from '../assets/icons/brand-learn.svg?react';
import TestIcon from '../assets/icons/brand-test.svg?react';
import WriteIcon from '../assets/icons/brand-write.svg?react';
import { decks, quizlet, stories, studySessions, type DeckStats, type SessionKind, type StudySession } from '../api';

const KIND: Record<SessionKind, { label: string; Icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }> = {
  'quizlet-learn': { label: 'Learn', Icon: LearnIcon },
  'quizlet-flashcards': { label: 'Flashcards', Icon: FlashcardsIcon },
  'quizlet-test': { label: 'Practice test', Icon: TestIcon },
  anki: { label: 'Anki review', Icon: Layers },
  reading: { label: 'Reading', Icon: BookOpen },
};

function linkFor(s: StudySession): string {
  switch (s.kind) {
    // Learn saves "Write · …" as its detail when it was in Write mode.
    case 'quizlet-learn': return `/quizlet/${s.ref_id}/study?mode=${s.detail?.startsWith('Write') ? 'write' : 'learn'}`;
    case 'quizlet-test': return `/quizlet/${s.ref_id}/study?mode=test`;
    case 'quizlet-flashcards': return `/quizlet/${s.ref_id}/study`;
    case 'anki': return `/anki/${s.ref_id}/study`;
    case 'reading': return `/reading?story=${s.ref_id}`;
  }
}

/** SQLite timestamps are UTC without a zone marker. */
function ago(ts: string, now: number): string {
  const t = Date.parse(ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const due = (s?: DeckStats) => (s ? s.new_count + s.learn_count + s.review_count : 0);

/** The Study tab: everything you can pick back up, plus Anki decks with cards due. */
export function StudyHub() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [ankiDecks, setAnkiDecks] = useState<{ name: string; id: number; stats?: DeckStats }[] | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      studySessions.list(),
      decks.list().catch(() => null), // Anki container may be offline
      quizlet.listDecks().catch(() => null),
      stories.list(100).catch(() => null),
    ]).then(([s, anki, qz, st]) => {
      if (cancelled) return;
      // Hide sessions whose deck or story no longer exists (when we can tell).
      const quizletIds = qz ? new Set(qz.decks.map(d => String(d.id))) : null;
      const ankiIds = anki ? new Set(Object.values(anki.decks).map(String)) : null;
      const storyIds = st && st.stories.length < 100 ? new Set(st.stories.map(x => String(x.id))) : null;
      setSessions(s.sessions.filter(x =>
        x.kind.startsWith('quizlet-') ? !quizletIds || quizletIds.has(x.ref_id)
        : x.kind === 'anki' ? !ankiIds || ankiIds.has(x.ref_id)
        : !storyIds || storyIds.has(x.ref_id)));
      if (anki) {
        setAnkiDecks(Object.entries(anki.decks)
          .map(([name, id]) => ({ name, id, stats: anki.stats[name] }))
          .filter(d => due(d.stats) > 0)
          .sort((a, b) => due(b.stats) - due(a.stats)));
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const ankiStats = useMemo(() => new Map((ankiDecks ?? []).map(d => [String(d.id), d.stats])), [ankiDecks]);

  const dismiss = (s: StudySession) => {
    setSessions(prev => prev.filter(x => !(x.kind === s.kind && x.ref_id === s.ref_id)));
    studySessions.remove(s.kind, s.ref_id).catch(() => {});
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-56 rounded" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-xl font-bold">Continue where you left off</h2>
          <p className="text-sm text-(--text-secondary)">Anything you started is saved here, even if you leave the app.</p>
        </div>
        {sessions.length === 0 ? (
          <div className="card text-center py-10 space-y-2">
            <PlayCircle className="w-8 h-8 mx-auto text-(--text-secondary)" />
            <p className="text-sm text-(--text-secondary)">
              Nothing in progress. Start a deck from the <Link to="/" className="text-(--accent) hover-underline">Decks</Link> tab
              or open a story in <Link to="/reading" className="text-(--accent) hover-underline">Reading</Link>.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3 anim-stagger">
            {sessions.map(s => {
              const isWrite = s.kind === 'quizlet-learn' && !!s.detail?.startsWith('Write');
              const { label, Icon } = isWrite ? { label: 'Write', Icon: WriteIcon } : KIND[s.kind];
              const pct = s.progress_total > 0 ? Math.min(100, (s.progress_done / s.progress_total) * 100) : 0;
              const liveDue = s.kind === 'anki' ? due(ankiStats.get(s.ref_id)) : null;
              const detail = s.kind === 'anki' && ankiDecks ? (liveDue ? `${liveDue} due now` : 'All caught up') : s.detail;
              return (
                <div key={`${s.kind}-${s.ref_id}`} role="link" tabIndex={0}
                  onClick={() => navigate(linkFor(s))}
                  onKeyDown={e => { if (e.key === 'Enter') navigate(linkFor(s)); }}
                  className="group relative rounded-xl bg-(--bg-secondary) hover:bg-(--bg-tertiary) transition-colors p-4 cursor-pointer flex flex-col gap-3">
                  <button onClick={e => { e.stopPropagation(); dismiss(s); }} title="Remove from list"
                    className="absolute top-2.5 right-2.5 p-1 rounded-md text-(--text-secondary) opacity-60 sm:opacity-0 group-hover:opacity-100 hover:text-white hover:bg-white/10 transition">
                    <X className="w-3.5 h-3.5" />
                  </button>
                  <div className="flex items-start gap-3 pr-6">
                    <div className="w-9 h-9 rounded-lg bg-(--accent)/10 flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5" style={{ color: 'var(--accent)' }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wider font-semibold text-(--text-secondary)">{label}</p>
                      <p className="font-semibold truncate">{s.title || 'Untitled'}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5 mt-auto">
                    <div className="h-1.5 bg-(--bg-primary)/60 rounded-full overflow-hidden">
                      <div className="h-full bg-(--accent) rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center justify-between text-xs text-(--text-secondary) gap-2">
                      <span className="truncate">{detail}</span>
                      <span className="shrink-0">{ago(s.updated_at, now)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {ankiDecks && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-bold">Due in Anki</h2>
            <Link to="/" className="text-sm text-(--text-secondary) hover-accent">All decks</Link>
          </div>
          {ankiDecks.length === 0 ? (
            <div className="card text-center py-6 text-sm text-(--text-secondary)">You’re all caught up — no Anki cards due.</div>
          ) : (
            <div className="space-y-2">
              {ankiDecks.slice(0, 8).map(d => {
                const parts = d.name.split('::');
                return (
                  <button key={d.id} onClick={() => navigate(`/anki/${d.id}/study`)}
                    className="w-full rounded-xl bg-(--bg-secondary) hover:bg-(--bg-tertiary) transition-colors px-4 py-3 flex items-center gap-4 text-left">
                    <div className="min-w-0 flex-1">
                      {parts.length > 1 && <p className="text-[11px] text-(--text-secondary) truncate">{parts.slice(0, -1).join(' › ')}</p>}
                      <p className="font-medium truncate">{parts[parts.length - 1]}</p>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-(--text-secondary) shrink-0 tabular-nums">
                      <span className="flex items-center gap-1"><Plus className="w-3.5 h-3.5 text-(--accent)" />{d.stats?.new_count ?? 0}</span>
                      <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-(--accent)" />{d.stats?.learn_count ?? 0}</span>
                      <span className="flex items-center gap-1"><BookOpen className="w-3.5 h-3.5 text-(--accent)" />{d.stats?.review_count ?? 0}</span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-(--text-secondary) shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
