import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Trash2, Loader2, ExternalLink, Plus } from 'lucide-react';
import { quizlet, type QuizletDeck } from '../api';

export function QuizletDecks() {
  const [decks, setDecks] = useState<QuizletDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const res = await quizlet.listDecks();
      setDecks(res.decks);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this deck?')) return;
    setDeletingId(id);
    try {
      await quizlet.deleteDeck(id);
      setDecks(d => d.filter(deck => deck.id !== id));
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Quizlet Decks</h2>
        {[1, 2, 3].map(i => (
          <div key={i} className="card skeleton h-20" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Quizlet Decks</h2>
        <button
          className="btn btn-primary flex items-center gap-2"
          onClick={() => navigate('/import')}
        >
          <Plus className="w-4 h-4" />
          Import Deck
        </button>
      </div>

      {decks.length === 0 ? (
        <div className="card text-center py-12 space-y-3">
          <BookOpen className="w-12 h-12 mx-auto text-(--text-secondary)" />
          <p className="text-(--text-secondary)">No Quizlet decks yet</p>
          <button className="btn btn-primary" onClick={() => navigate('/import')}>
            Import from Quizlet
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {decks.map(deck => (
            <div
              key={deck.id}
              className="card card-hover cursor-pointer flex items-center justify-between gap-4"
              onClick={() => navigate(`/quizlet/${deck.id}/study`)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: '#4257b2' }}
                >
                  <span className="text-white font-bold text-sm">Q</span>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold truncate">{deck.title}</p>
                  <p className="text-sm text-(--text-secondary)">
                    {deck.card_count} cards · {new Date(deck.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {deck.url && (
                  <a
                    href={deck.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="icon-btn"
                    title="Open on Quizlet"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
                <button
                  className="icon-btn icon-btn-danger"
                  onClick={e => handleDelete(deck.id, e)}
                  disabled={deletingId === deck.id}
                  title="Delete deck"
                >
                  {deletingId === deck.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />
                  }
                </button>
                <button className="btn btn-primary text-sm px-3 py-1.5">
                  Study
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
