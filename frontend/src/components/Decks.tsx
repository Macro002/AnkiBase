import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, Clock, Plus, Pencil, Trash2, ChevronRight, FolderOpen, X, ExternalLink, TrendingUp, Star, Layers } from 'lucide-react';
import { decks, quizlet, type DeckStats, type QuizletDeck } from '../api';
import { Heatmap } from './Heatmap';

interface DeckInfo {
  name: string;
  id: number;
  stats?: DeckStats;
  hasSubdecks: boolean;
  isSubdeck: boolean;
  parentName: string | null;
  displayName: string;
}

export function Decks() {
  const { t } = useTranslation();
  const [deckList, setDeckList] = useState<DeckInfo[]>([]);
  const [quizletDecks, setQuizletDecks] = useState<QuizletDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentPath, setCurrentPath] = useState<string[]>([]);
  const [renameModal, setRenameModal] = useState<{ deck: DeckInfo; newName: string } | null>(null);
  const [deleteModal, setDeleteModal] = useState<DeckInfo | null>(null);
  const [quizletRenameModal, setQuizletRenameModal] = useState<{ deck: QuizletDeck; newName: string } | null>(null);
  const [quizletDeleteModal, setQuizletDeleteModal] = useState<QuizletDeck | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [quizletStats, setQuizletStats] = useState<Record<number, number>>({});
  const navigate = useNavigate();

  useEffect(() => {
    loadDecks();
    quizlet.listDecks().then(r => {
      setQuizletDecks(r.decks);
      Promise.all(r.decks.map(d => quizlet.deckStats(d.id).then(s => [d.id, s.studied_today] as const)))
        .then(entries => setQuizletStats(Object.fromEntries(entries)))
        .catch(() => {});
    }).catch(() => {});
  }, []);

  // Reload decks when sync completes
  useEffect(() => {
    const handleSyncComplete = () => {
      loadDecks();
    };

    window.addEventListener('anki-sync-complete', handleSyncComplete);
    return () => window.removeEventListener('anki-sync-complete', handleSyncComplete);
  }, []);

  const loadDecks = async () => {
    try {
      const data = await decks.list();
      const list: DeckInfo[] = Object.entries(data.decks).map(([name, id]) => {
        const parts = name.split('::');
        const isSubdeck = parts.length > 1;
        const parentName = isSubdeck ? parts.slice(0, -1).join('::') : null;
        const displayName = parts[parts.length - 1];

        // Check if this deck has subdecks
        const hasSubdecks = Object.keys(data.decks).some(
          (n) => n !== name && n.startsWith(name + '::')
        );

        return {
          name,
          id,
          stats: data.stats[id],
          hasSubdecks,
          isSubdeck,
          parentName,
          displayName,
        };
      });

      // Sort by name, but put Default at top
      list.sort((a, b) => {
        if (a.name === 'Default') return -1;
        if (b.name === 'Default') return 1;
        return a.name.localeCompare(b.name);
      });

      setDeckList(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load decks');
    } finally {
      setLoading(false);
    }
  };

  const handleStudy = (deck: DeckInfo) => {
    navigate(`/anki/${deck.id}/study`);
  };

  const handleViewDeck = (deckName: string) => {
    setCurrentPath(deckName.split('::'));
  };

  const handleBreadcrumb = (index: number) => {
    if (index < 0) {
      setCurrentPath([]);
    } else {
      setCurrentPath(currentPath.slice(0, index + 1));
    }
  };

  const handleRename = async () => {
    if (!renameModal || !renameModal.newName.trim()) return;

    setActionLoading(true);
    try {
      // For subdecks, preserve the parent path
      const parts = renameModal.deck.name.split('::');
      parts[parts.length - 1] = renameModal.newName.trim();
      const newFullName = parts.join('::');

      await decks.rename(renameModal.deck.name, newFullName);
      setRenameModal(null);
      await loadDecks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename deck');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteModal) return;

    setActionLoading(true);
    try {
      await decks.delete(deleteModal.name);
      setDeleteModal(null);
      await loadDecks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete deck');
    } finally {
      setActionLoading(false);
    }
  };

  const handleQuizletRename = async () => {
    if (!quizletRenameModal || !quizletRenameModal.newName.trim()) return;
    setActionLoading(true);
    try {
      await quizlet.renameDeck(quizletRenameModal.deck.id, quizletRenameModal.newName.trim());
      setQuizletDecks(d => d.map(x => x.id === quizletRenameModal.deck.id ? { ...x, title: quizletRenameModal.newName.trim() } : x));
      setQuizletRenameModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename deck');
    } finally {
      setActionLoading(false);
    }
  };

  const handleQuizletDelete = async () => {
    if (!quizletDeleteModal) return;
    setActionLoading(true);
    try {
      await quizlet.deleteDeck(quizletDeleteModal.id);
      setQuizletDecks(d => d.filter(x => x.id !== quizletDeleteModal.id));
      setQuizletDeleteModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete deck');
    } finally {
      setActionLoading(false);
    }
  };

  // Filter decks based on current path
  const currentPrefix = currentPath.length > 0 ? currentPath.join('::') : null;
  const visibleDecks = deckList.filter((deck) => {
    if (currentPrefix === null) {
      // Show only top-level decks
      return !deck.isSubdeck;
    } else {
      // Show direct children of current path
      if (!deck.name.startsWith(currentPrefix + '::')) return false;
      const remainder = deck.name.slice(currentPrefix.length + 2);
      return !remainder.includes('::'); // Only direct children
    }
  });

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Heatmap skeleton */}
        <div className="card">
          <div className="skeleton h-8 w-32 mb-4"></div>
          <div className="skeleton h-32 w-full"></div>
        </div>

        {/* Current path skeleton */}
        <div className="flex items-center gap-2">
          <div className="skeleton h-8 w-20"></div>
        </div>

        {/* Decks grid skeleton */}
        <div>
          <div className="skeleton h-7 w-24 mb-4"></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card border border-(--bg-tertiary)">
                <div className="skeleton h-6 w-32 mb-3"></div>
                <div className="flex gap-4 mb-3">
                  <div className="skeleton h-4 w-16"></div>
                  <div className="skeleton h-4 w-16"></div>
                </div>
                <div className="flex justify-between items-center">
                  <div className="skeleton h-8 w-20"></div>
                  <div className="flex gap-1">
                    <div className="skeleton h-8 w-8 rounded"></div>
                    <div className="skeleton h-8 w-8 rounded"></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card text-center">
        <p className="text-(--error)">{error}</p>
        <button onClick={() => { setError(''); loadDecks(); }} className="btn btn-primary mt-4">
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Heatmap */}
      <Heatmap />

      {/* Breadcrumb navigation */}
      {currentPath.length > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => handleBreadcrumb(-1)}
            className="text-(--accent) hover-underline"
          >
            {t('decks.title')}
          </button>
          {currentPath.map((part, index) => (
            <span key={index} className="flex items-center gap-2">
              <ChevronRight className="w-4 h-4 text-(--text-secondary)" />
              <button
                onClick={() => handleBreadcrumb(index)}
                className={index === currentPath.length - 1
                  ? 'text-white'
                  : 'text-(--accent) hover-underline'
                }
              >
                {part}
              </button>
            </span>
          ))}
        </div>
      )}

      <h2 className="text-xl font-bold">
        {currentPath.length > 0 ? currentPath[currentPath.length - 1] : 'My Anki Decks'}
      </h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visibleDecks.map((deck) => (
          <div
            key={deck.id}
            className="card border border-(--bg-tertiary) hover-border-accent transition-all cursor-pointer flex flex-col relative group"
            onClick={() => handleStudy(deck)}
          >
            {/* Edit/Delete buttons - always visible */}
            <div className="absolute top-3 right-3 flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameModal({ deck, newName: deck.displayName });
                }}
                className="icon-btn"
                title={t('decks.rename')}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteModal(deck);
                }}
                className="icon-btn icon-btn-danger"
                title={t('decks.delete')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Deck name with tooltip */}
            <h3
              className="font-semibold text-lg mb-3 truncate pr-8 group-hover-accent transition-colors"
              title={deck.name}
            >
              {deck.displayName}
            </h3>

            {/* Stats row */}
            <div className="flex items-center gap-3 mb-4 text-sm text-(--text-secondary) flex-wrap">
              <span className="flex items-center gap-1">
                <Plus className="w-3.5 h-3.5 text-(--accent)" />
                {deck.stats?.new_count ?? 0} new
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-(--accent)" />
                {deck.stats?.learn_count ?? 0} learning
              </span>
              <span className="flex items-center gap-1">
                <BookOpen className="w-3.5 h-3.5 text-(--accent)" />
                {deck.stats?.review_count ?? 0} review
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 mt-auto">
              {deck.hasSubdecks ? (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleViewDeck(deck.name); }}
                    className="btn btn-secondary flex-1 flex items-center justify-center gap-2"
                  >
                    <FolderOpen className="w-4 h-4" />
                    {t('common.view', 'View')}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleStudy(deck); }}
                    className="btn btn-primary"
                    title={t('decks.studyNow')}
                  >
                    {t('nav.study')}
                  </button>
                </>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); handleStudy(deck); }}
                  className="btn btn-primary flex-1"
                >
                  {t('nav.study')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {visibleDecks.length === 0 && (
        <div className="card text-center text-(--text-secondary)">
          {currentPath.length > 0
            ? t('decks.noSubdecks', 'No subdecks found in this deck.')
            : t('decks.noDecks')}
        </div>
      )}

      {/* Quizlet Decks section */}
      {currentPath.length === 0 && (
        <div className="space-y-3">
          <h2 className="text-xl font-bold">My Quizlet Decks</h2>
          {quizletDecks.length === 0 ? (
            <div className="card text-center text-(--text-secondary) py-6 text-sm">
              No Quizlet decks yet —{' '}
              <button className="hover-accent" onClick={() => navigate('/import')}>
                import one
              </button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {quizletDecks.map(deck => (
                <div
                  key={deck.id}
                  className="card border border-(--bg-tertiary) hover-border-accent transition-all cursor-pointer flex flex-col relative group"
                  onClick={() => navigate(`/quizlet/${deck.id}/study`)}
                >
                  <div className="absolute top-3 right-3 flex items-center gap-1">
                    {deck.url && (
                      <a
                        href={deck.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="icon-btn"
                        title="Open on Quizlet"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <button
                      className="icon-btn"
                      title="Rename"
                      onClick={e => {
                        e.stopPropagation();
                        setQuizletRenameModal({ deck, newName: deck.title });
                      }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      className="icon-btn icon-btn-danger"
                      title="Delete"
                      onClick={e => {
                        e.stopPropagation();
                        setQuizletDeleteModal(deck);
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center gap-2 mb-3 pr-16">
                    <div className="w-6 h-6 rounded flex items-center justify-center shrink-0" style={{ background: '#4257b2' }}>
                      <span className="text-white font-bold text-xs">Q</span>
                    </div>
                    <h3 className="font-semibold text-lg truncate group-hover-accent transition-colors">
                      {deck.title}
                    </h3>
                  </div>

                  <div className="flex items-center gap-3 text-sm text-(--text-secondary) mb-4 flex-wrap">
                    <span className="flex items-center gap-1"><Layers className="w-3.5 h-3.5 text-(--accent)" />{deck.card_count} cards</span>
                    <span className="flex items-center gap-1">
                      <TrendingUp className="w-3.5 h-3.5 text-(--accent)" />
                      {quizletStats[deck.id] ?? 0} today
                    </span>
                    <span className="flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 fill-(--accent) text-(--accent)" />
                      {deck.favorites_count ?? 0} favorited
                    </span>
                  </div>

                  <button className="btn btn-primary mt-auto" onClick={e => { e.stopPropagation(); navigate(`/quizlet/${deck.id}/study`); }}>
                    Study
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quizlet Rename Modal */}
      {quizletRenameModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Rename Quizlet Deck</h3>
              <button onClick={() => setQuizletRenameModal(null)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={quizletRenameModal.newName}
              onChange={(e) => setQuizletRenameModal({ ...quizletRenameModal, newName: e.target.value })}
              className="input w-full mb-4"
              placeholder="Deck name"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleQuizletRename()}
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setQuizletRenameModal(null)} className="btn btn-secondary" disabled={actionLoading}>
                {t('decks.cancel')}
              </button>
              <button onClick={handleQuizletRename} className="btn btn-primary" disabled={actionLoading || !quizletRenameModal.newName.trim()}>
                {actionLoading ? t('decks.renaming') : t('decks.rename')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quizlet Delete Modal */}
      {quizletDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">Delete Quizlet Deck</h3>
              <button onClick={() => setQuizletDeleteModal(null)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-(--text-secondary) mb-4">
              Delete "<span className="text-white">{quizletDeleteModal.title}</span>"? This will remove all {quizletDeleteModal.card_count} cards.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setQuizletDeleteModal(null)} className="btn btn-secondary" disabled={actionLoading}>
                {t('decks.cancel')}
              </button>
              <button onClick={handleQuizletDelete} className="btn btn-error" disabled={actionLoading}>
                {actionLoading ? t('decks.deleting') : t('decks.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{t('decks.renameDeck')}</h3>
              <button onClick={() => setRenameModal(null)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={renameModal.newName}
              onChange={(e) => setRenameModal({ ...renameModal, newName: e.target.value })}
              className="input w-full mb-4"
              placeholder={t('decks.newName')}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRenameModal(null)}
                className="btn btn-secondary"
                disabled={actionLoading}
              >
                {t('decks.cancel')}
              </button>
              <button
                onClick={handleRename}
                className="btn btn-primary"
                disabled={actionLoading || !renameModal.newName.trim()}
              >
                {actionLoading ? t('decks.renaming') : t('decks.rename')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">{t('decks.deleteDeck')}</h3>
              <button onClick={() => setDeleteModal(null)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-(--text-secondary) mb-4">
              {t('decks.deleteConfirm')} "<span className="text-white">{deleteModal.displayName}</span>"?
              {deleteModal.hasSubdecks && (
                <span className="block mt-2 text-red-400">
                  {t('decks.deleteSubdecksWarning', 'Warning: This will also delete all subdecks and their cards!')}
                </span>
              )}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteModal(null)}
                className="btn btn-secondary"
                disabled={actionLoading}
              >
                {t('decks.cancel')}
              </button>
              <button
                onClick={handleDelete}
                className="btn btn-error"
                disabled={actionLoading}
              >
                {actionLoading ? t('decks.deleting') : t('decks.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
