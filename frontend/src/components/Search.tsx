import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check, Edit2, ChevronDown, ChevronUp } from 'lucide-react';
import { search, decks as decksApi, lookup, type Note } from '../api';

interface DeckOption {
  name: string;
  enabled: boolean;
}

interface JishoResult {
  slug: string;
  japanese: { word?: string; reading: string }[];
  senses: { english_definitions: string[]; parts_of_speech: string[] }[];
  jlpt?: string[];
  is_common?: boolean;
}

export function Search() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Note[]>([]);
  const [jishoResults, setJishoResults] = useState<JishoResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  // Toggles - with localStorage persistence
  const [searchDecks, setSearchDecks] = useState(() => {
    const saved = localStorage.getItem('search-decks');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [searchJisho, setSearchJisho] = useState(() => {
    const saved = localStorage.getItem('search-jisho');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [deckOptions, setDeckOptions] = useState<DeckOption[]>([]);
  const [showDeckFilter, setShowDeckFilter] = useState(false);

  // Persist toggles to localStorage
  useEffect(() => {
    localStorage.setItem('search-decks', JSON.stringify(searchDecks));
  }, [searchDecks]);

  useEffect(() => {
    localStorage.setItem('search-jisho', JSON.stringify(searchJisho));
  }, [searchJisho]);

  // Selected items for detail view
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [selectedJisho, setSelectedJisho] = useState<JishoResult | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Load decks on mount
  useEffect(() => {
    const loadDecks = async () => {
      try {
        const data = await decksApi.list();
        const deckNames = Object.keys(data.decks).filter(d => !d.includes('::'));
        setDeckOptions(deckNames.map(name => ({ name, enabled: true })));
      } catch (err) {
        console.error('Failed to load decks:', err);
      }
    };
    loadDecks();
  }, []);

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    setSearched(true);
    setResults([]);
    setJishoResults([]);
    setSelectedNote(null);
    setSelectedJisho(null);

    try {
      // Search Anki decks
      if (searchDecks) {
        const enabledDecks = deckOptions.filter(d => d.enabled).map(d => d.name);
        let searchQuery = query;

        if (enabledDecks.length > 0 && enabledDecks.length < deckOptions.length) {
          const deckFilter = enabledDecks.map(d => `"deck:${d}"`).join(' OR ');
          searchQuery = `(${deckFilter}) ${query}`;
        }

        const data = await search.notes(searchQuery);
        setResults(data.notes);
        setTotal(data.total);
      }

      // Search Jisho
      if (searchJisho) {
        try {
          const jishoData = await lookup.jisho(query);
          setJishoResults(jishoData.data?.slice(0, 10) || []);
        } catch (err) {
          console.error('Jisho search failed:', err);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  // Get the value of the Nth field (0-indexed) by order, or try common field names
  const getFieldValue = (note: Note, fieldNames: string[], fieldIndex: number): string => {
    // First try the specified field names
    for (const name of fieldNames) {
      const field = note.fields[name];
      if (field?.value) {
        return field.value;
      }
    }
    // Fall back to Nth field by order
    const sortedFields = Object.values(note.fields).sort((a, b) => a.order - b.order);
    return sortedFields[fieldIndex]?.value || '';
  };

  const handleSaveField = async () => {
    if (!selectedNote || !editingField) return;
    setSelectedNote({
      ...selectedNote,
      fields: {
        ...selectedNote.fields,
        [editingField]: {
          ...selectedNote.fields[editingField],
          value: editValue
        }
      }
    });
    setEditingField(null);
  };

  const toggleAllDecks = (enabled: boolean) => {
    setDeckOptions(opts => opts.map(o => ({ ...o, enabled })));
  };

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      {/* Search Form */}
      <form onSubmit={handleSearch} className="space-y-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.searchPlaceholder')}
            className="input flex-1"
          />
          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? t('search.searching') : t('common.search', 'Search')}
          </button>
        </div>

        {/* Toggles - styled better */}
        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={() => setSearchDecks(!searchDecks)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-all ${
              searchDecks
                ? 'bg-(--accent) text-white'
                : 'bg-(--bg-tertiary) text-(--text-secondary)'
            }`}
          >
            {t('search.anki')}
          </button>

          <button
            type="button"
            onClick={() => setSearchJisho(!searchJisho)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-all ${
              searchJisho
                ? 'bg-(--accent) text-white'
                : 'bg-(--bg-tertiary) text-(--text-secondary)'
            }`}
          >
            {t('search.jisho')}
          </button>

          {searchDecks && (
            <button
              type="button"
              onClick={() => setShowDeckFilter(!showDeckFilter)}
              className="px-3 py-1.5 rounded text-sm bg-(--bg-tertiary) text-(--text-secondary) flex items-center gap-1"
            >
              {t('nav.decks')}
              {showDeckFilter ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>

        {/* Deck filter */}
        {searchDecks && showDeckFilter && (
          <div className="bg-(--bg-tertiary) rounded-lg p-3 space-y-2">
            <div className="flex gap-3 text-xs">
              <button type="button" onClick={() => toggleAllDecks(true)} className="text-(--accent)">
                {t('common.all', 'All')}
              </button>
              <button type="button" onClick={() => toggleAllDecks(false)} className="text-(--text-secondary)">
                {t('common.none', 'None')}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {deckOptions.map((deck) => (
                <button
                  key={deck.name}
                  type="button"
                  onClick={() => {
                    setDeckOptions(opts =>
                      opts.map(o => o.name === deck.name ? { ...o, enabled: !o.enabled } : o)
                    );
                  }}
                  className={`px-2 py-1 rounded text-xs transition-all ${
                    deck.enabled
                      ? 'bg-(--accent) text-white'
                      : 'bg-(--bg-secondary) text-(--text-secondary)'
                  }`}
                >
                  {deck.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>

      {/* Error */}
      {error && (
        <div className="card bg-red-900/20 border border-red-500 text-(--error)">
          {error}
        </div>
      )}

      {/* Selected Jisho Detail View */}
      {selectedJisho && (
        <div className="card space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <div className="text-3xl font-bold">
                {selectedJisho.japanese?.[0]?.word || selectedJisho.japanese?.[0]?.reading}
              </div>
              {selectedJisho.japanese?.[0]?.reading && selectedJisho.japanese?.[0]?.word && (
                <div className="text-lg text-(--text-secondary)">
                  {selectedJisho.japanese[0].reading}
                </div>
              )}
            </div>
            <button onClick={() => setSelectedJisho(null)} className="icon-btn">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-2">
            {selectedJisho.is_common && (
              <span className="px-2 py-1 rounded text-xs bg-green-500/20 text-green-400">{t('search.common')}</span>
            )}
            {selectedJisho.jlpt?.map(level => (
              <span key={level} className="px-2 py-1 rounded text-xs bg-(--accent)/20 text-(--accent)">
                {level.toUpperCase()}
              </span>
            ))}
          </div>

          {/* All readings */}
          {selectedJisho.japanese.length > 1 && (
            <div>
              <div className="text-xs text-(--text-secondary) mb-1">{t('search.otherForms', 'Other forms')}</div>
              <div className="flex flex-wrap gap-2">
                {selectedJisho.japanese.slice(1).map((j, i) => (
                  <span key={i} className="text-sm">
                    {j.word || j.reading}
                    {j.reading && j.word && <span className="text-(--text-secondary)"> ({j.reading})</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* All meanings */}
          <div className="space-y-3">
            {selectedJisho.senses.map((sense, i) => (
              <div key={i} className="border-l-2 border-(--accent) pl-3">
                <div className="text-xs text-(--text-secondary) mb-1">
                  {sense.parts_of_speech.join(', ')}
                </div>
                <div>{sense.english_definitions.join('; ')}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Selected Note Detail View */}
      {selectedNote && (
        <div className="card space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">{t('search.cardDetails', 'Card Details')}</h3>
            <button onClick={() => setSelectedNote(null)} className="icon-btn">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="text-xs text-(--text-secondary)">{selectedNote.modelName}</div>

          <div className="space-y-3">
            {Object.entries(selectedNote.fields)
              .sort(([, a], [, b]) => a.order - b.order)
              .map(([fieldName, field]) => (
                <div key={fieldName} className="border border-(--bg-tertiary) rounded-lg p-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-medium text-(--text-secondary)">{fieldName}</span>
                    {editingField !== fieldName ? (
                      <button
                        onClick={() => {
                          setEditingField(fieldName);
                          setEditValue(field.value);
                        }}
                        className="text-xs text-(--accent) flex items-center gap-1"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                    ) : (
                      <div className="flex gap-1">
                        <button onClick={handleSaveField} className="text-green-400">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={() => setEditingField(null)} className="text-red-400">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {editingField === fieldName ? (
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="input w-full min-h-[60px] resize-none text-sm"
                      autoFocus
                    />
                  ) : (
                    <div
                      className="anki-content text-sm"
                      dangerouslySetInnerHTML={{ __html: field.value || `<span class="italic text-(--text-secondary)">${t('common.empty', 'Empty')}</span>` }}
                    />
                  )}
                </div>
              ))}
          </div>

          {selectedNote.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-2 border-t border-(--bg-tertiary)">
              {selectedNote.tags.map((tag) => (
                <span key={tag} className="text-xs bg-(--bg-tertiary) px-2 py-1 rounded">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {searched && !error && !selectedNote && !selectedJisho && (
        <div className="space-y-4">
          {/* Jisho Results */}
          {searchJisho && jishoResults.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-(--text-secondary)">{t('search.jisho')} ({jishoResults.length})</h3>
              <div className="space-y-2">
                {jishoResults.map((result, idx) => (
                  <div
                    key={idx}
                    className="card p-3 cursor-pointer card-hover"
                    onClick={() => setSelectedJisho(result)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="text-xl font-bold">
                        {result.japanese?.[0]?.word || result.japanese?.[0]?.reading}
                      </div>
                      {result.japanese?.[0]?.reading && result.japanese?.[0]?.word && (
                        <div className="text-sm text-(--text-secondary) mt-1">
                          {result.japanese[0].reading}
                        </div>
                      )}
                      {result.is_common && (
                        <span className="px-1.5 py-0.5 rounded text-xs bg-green-500/20 text-green-400 mt-1">
                          {t('search.common')}
                        </span>
                      )}
                    </div>
                    <div className="text-sm mt-1">
                      {result.senses?.[0]?.english_definitions?.join(', ')}
                    </div>
                    <div className="text-xs text-(--text-secondary) mt-1">
                      {result.senses?.[0]?.parts_of_speech?.join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Anki Results */}
          {searchDecks && (
            <div className="space-y-2">
              <p className="text-sm text-(--text-secondary)">
                {total === 0 ? t('search.noResults') : `${t('search.cards')} (${total}${results.length < total ? `, ${t('search.showing')} ${results.length}` : ''})`}
              </p>

              <div className="space-y-2">
                {results.map((note) => (
                  <div
                    key={note.noteId}
                    className="card p-4 cursor-pointer card-hover"
                    onClick={() => setSelectedNote(note)}
                  >
                    <div
                      className="anki-content font-medium"
                      dangerouslySetInnerHTML={{
                        __html: getFieldValue(note, ['Front', 'Question', 'Word', 'Expression', 'Vocabulary-Kanji'], 0),
                      }}
                    />
                    <div
                      className="anki-content text-(--text-secondary) text-sm mt-1"
                      dangerouslySetInnerHTML={{
                        __html: getFieldValue(note, ['Back', 'Answer', 'Meaning', 'Definition', 'Vocabulary-English'], 1),
                      }}
                    />
                    <div className="text-xs text-(--text-secondary) mt-2">
                      {note.modelName}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
