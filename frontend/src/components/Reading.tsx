import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Trash2, Edit2, Check, X, ChevronLeft, Clock, Cpu, FileText, Loader2, Volume2, Sparkles } from 'lucide-react';
import { stories, lookup, media } from '../api';
import type { SavedStory } from '../api';

// Cache for word lookups
const lookupCache = new Map<string, { meaning: string; reading?: string; provider?: string }>();

// Extract sound filename from field value like [sound:audio.mp3]
function extractSoundFile(fieldValue: string): string | null {
  const match = fieldValue.match(/\[sound:([^\]]+)\]/);
  return match ? match[1] : null;
}

// Tokenize text into individual clickable units
function tokenizeText(text: string): { text: string; start: number }[] {
  const tokens: { text: string; start: number }[] = [];
  const hasCJK = /[\u3000-\u9fff\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/.test(text);

  if (hasCJK) {
    const cjkPattern = /([一-龯]+|[ぁ-んー]+|[ァ-ヴー]+|[a-zA-ZÀ-ÿ]+|[0-9]+|[\s]+|.)/g;
    let match;
    while ((match = cjkPattern.exec(text)) !== null) {
      tokens.push({ text: match[0], start: match.index });
    }
  } else {
    const wordPattern = /([a-zA-ZÀ-ÿ]+|[0-9]+|[\s]+|.)/g;
    let match;
    while ((match = wordPattern.exec(text)) !== null) {
      tokens.push({ text: match[0], start: match.index });
    }
  }

  return tokens;
}

function isClickableWord(token: string): boolean {
  return /[a-zA-ZÀ-ÿ0-9一-龯ぁ-んァ-ヴー]/.test(token);
}

interface StoryContentProps {
  content: string;
  words: string[];
  onWordClick: (word: string, isVocab: boolean, rect: DOMRect) => void;
}

function StoryContent({ content, words, onWordClick }: StoryContentProps) {
  const vocabSet = useMemo(() => {
    const set = new Set<string>();
    for (const word of words) {
      set.add(word.toLowerCase());
    }
    return set;
  }, [words]);

  const isVocabWord = useCallback((token: string): boolean => {
    return vocabSet.has(token.toLowerCase());
  }, [vocabSet]);

  const handleClick = useCallback((token: string, isVocab: boolean, event: React.MouseEvent) => {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    onWordClick(token, isVocab, rect);
  }, [onWordClick]);

  const processLine = useCallback((line: string, lineKey: number): React.ReactNode => {
    const tokens = tokenizeText(line);

    return tokens.map((token, idx) => {
      const isWord = isClickableWord(token.text);
      const isVocab = isWord && isVocabWord(token.text);

      if (!isWord) {
        return <span key={`${lineKey}-${idx}`}>{token.text}</span>;
      }

      return (
        <span
          key={`${lineKey}-${idx}-${token.start}`}
          className={`word-btn ${isVocab ? 'vocab' : ''}`}
          onClick={(e) => handleClick(token.text, isVocab, e)}
        >
          {token.text}
        </span>
      );
    });
  }, [isVocabWord, handleClick]);

  const renderContent = useCallback(() => {
    const lines = content.split('\n');
    return lines.map((line, i) => {
      if (!line.trim()) {
        return <br key={`br-${i}`} />;
      }
      return (
        <p key={`p-${i}`} className="mb-3 leading-relaxed">
          {processLine(line, i)}
        </p>
      );
    });
  }, [content, processLine]);

  return (
    <div className="story-content prose prose-invert max-w-none">
      {renderContent()}
      <style>{`
        .word-btn {
          cursor: pointer;
          transition: all 0.15s;
        }
        .word-btn:hover {
          background: var(--bg-tertiary);
          border-radius: 2px;
        }
        .word-btn.vocab {
          color: var(--accent);
          font-weight: 600;
        }
        .word-btn.vocab:hover {
          background: rgba(233, 69, 96, 0.2);
        }
      `}</style>
    </div>
  );
}

// Tooltip component for word lookup
interface WordTooltipProps {
  word: string;
  isVocab: boolean;
  fields: Record<string, string> | null;
  lookupFields: string[];
  lookupLanguage: string;
  position: { x: number; y: number };
  onClose: () => void;
}

function WordTooltip({ word, isVocab, fields, lookupFields, lookupLanguage, position, onClose }: WordTooltipProps) {
  const [jishoLookup, setJishoLookup] = useState<{ meaning: string; reading?: string; provider?: string } | null>(null);
  const [aiLookup, setAiLookup] = useState<any | null>(null);  // Can contain any fields from AI lookup
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAI, setShowAI] = useState(false);
  const [playingAudio, setPlayingAudio] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Find sound file in fields
  const soundFile = useMemo(() => {
    if (!fields) return null;
    for (const value of Object.values(fields)) {
      const sound = extractSoundFile(value);
      if (sound) return sound;
    }
    return null;
  }, [fields]);

  // Clear old lookup data when word changes
  useEffect(() => {
    setJishoLookup(null);
    setAiLookup(null);
    setError(null);
    setShowAI(false);
  }, [word]);

  // Play audio
  const playAudio = async () => {
    if (!soundFile || playingAudio) return;
    setPlayingAudio(true);
    try {
      const result = await media.get(soundFile);
      if (result.data) {
        // Determine mime type
        const ext = soundFile.split('.').pop()?.toLowerCase();
        const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/wav';
        const audio = new Audio(`data:${mimeType};base64,${result.data}`);
        audio.play();
        audio.onended = () => setPlayingAudio(false);
      }
    } catch (err) {
      console.error('Failed to play audio:', err);
    } finally {
      setPlayingAudio(false);
    }
  };

  // Fetch lookup for non-vocab words
  useEffect(() => {
    if (!isVocab && !fields) {
      const cached = lookupCache.get(word);
      if (cached) {
        setJishoLookup(cached);
        return;
      }

      setLoading(true);
      setError(null);
      lookup.word(word, lookupLanguage)
        .then(result => {
          const data = { meaning: result.meaning, reading: result.reading, provider: result.provider_used };
          lookupCache.set(word, data);
          setJishoLookup(data);
        })
        .catch(err => {
          setError('Failed to lookup');
          console.error('Lookup failed:', err);
        })
        .finally(() => setLoading(false));
    }
  }, [word, isVocab, fields, lookupLanguage]);

  // Fetch AI lookup when requested
  const fetchAILookup = async () => {
    if (aiLoading || aiLookup) return;
    setAiLoading(true);
    try {
      const result = await lookup.word(
        word,
        lookupLanguage,
        undefined,  // provider - let backend choose based on configured keys
        undefined,  // model - let backend choose default
        lookupFields.length > 0 ? lookupFields : undefined,  // pass lookup fields
        true  // force_ai - skip Jisho and use AI directly
      );
      setAiLookup(result);
    } catch (err) {
      console.error('AI lookup failed:', err);
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Don't close if clicking on a word button (for instant lookup)
      const target = e.target as HTMLElement;
      if (target.closest('.word-btn')) return;
      onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('keydown', handleEsc);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  // Get fields to display
  const displayFields = useMemo(() => {
    if (!fields) return [];

    if (lookupFields.length > 0) {
      return lookupFields
        .filter(f => fields[f] && fields[f].trim())
        .map(f => ({ name: f, value: fields[f].replace(/\[sound:[^\]]+\]/g, '').replace(/<[^>]+>/g, '').trim() }))
        .filter(({ value }) => value);  // Only show fields that have content after removing tags
    }

    return Object.entries(fields)
      .filter(([_, v]) => v && v.trim())
      .map(([k, v]) => ({ name: k, value: v.replace(/\[sound:[^\]]+\]/g, '').replace(/<[^>]+>/g, '').trim() }))
      .filter(({ value }) => value);  // Only show fields that have content after removing tags
  }, [fields, lookupFields]);

  // Calculate tooltip position - below the word
  const tooltipStyle = useMemo(() => {
    const tooltipWidth = 280;
    const maxHeight = 300;

    let left = position.x - tooltipWidth / 2;
    // Position below the word (position.y is the top of the word, add ~25px for word height)
    let top = position.y + 25;

    // Keep within horizontal bounds
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth - 10) {
      left = window.innerWidth - tooltipWidth - 10;
    }

    // If tooltip would go off bottom, limit maxHeight
    const availableHeight = window.innerHeight - top - 10;
    const effectiveMaxHeight = Math.min(maxHeight, availableHeight);

    return { left, top, maxHeight: effectiveMaxHeight };
  }, [position]);

  return (
    <div
      ref={tooltipRef}
      className="word-tooltip"
      style={{
        position: 'fixed',
        left: tooltipStyle.left,
        top: tooltipStyle.top,
        maxHeight: tooltipStyle.maxHeight,
        overflowY: 'auto',
        zIndex: 1000,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-lg">{word}</span>
          {isVocab && (
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--accent)', color: 'white' }}>
              vocab
            </span>
          )}
        </div>
        {soundFile && (
          <button
            onClick={playAudio}
            className="icon-btn"
            disabled={playingAudio}
            title="Play audio"
          >
            <Volume2 className={`w-4 h-4 ${playingAudio ? 'animate-pulse' : ''}`} />
          </button>
        )}
      </div>

      {/* Vocab word fields */}
      {displayFields.length > 0 && (
        <div className="space-y-2 mb-2">
          {displayFields.map(({ name, value }) => {
            // Highlight the vocab word in the field value
            const highlightWord = (text: string) => {
              const regex = new RegExp(`(${word})`, 'gi');
              const parts = text.split(regex);
              return parts.map((part, i) =>
                regex.test(part)
                  ? <span key={i} style={{ color: 'var(--accent)', fontWeight: 600 }}>{part}</span>
                  : part
              );
            };

            return (
              <div key={name} className="text-sm">
                <span style={{ color: 'var(--text-secondary)' }}>{name}:</span>
                <span className="ml-2">{highlightWord(value)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Non-vocab word - Jisho/AI lookup */}
      {!isVocab && !fields && (
        <div className="space-y-2">
          {loading && (
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Looking up...
            </div>
          )}
          {error && (
            <div className="text-sm" style={{ color: 'var(--error)' }}>{error}</div>
          )}
          {jishoLookup && (
            <div className="space-y-1.5">
              {jishoLookup.reading && (
                <div className="text-sm">
                  <span style={{ color: 'var(--text-secondary)' }}>Reading:</span>
                  <span className="ml-2">{jishoLookup.reading}</span>
                </div>
              )}
              <div className="text-sm">
                <span style={{ color: 'var(--text-secondary)' }}>Meaning:</span>
                <span className="ml-2">{jishoLookup.meaning}</span>
              </div>
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                via {jishoLookup.provider}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vocab word but no field data */}
      {isVocab && displayFields.length === 0 && (
        <div className="text-sm italic" style={{ color: 'var(--text-secondary)' }}>
          No field data available
        </div>
      )}

      {/* Ask AI button */}
      {jishoLookup && jishoLookup.provider === 'jisho' && !showAI && (
        <button
          onClick={() => {
            setShowAI(true);
            fetchAILookup();
          }}
          className="mt-2 flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          <Sparkles className="w-3 h-3" />
          Ask AI
        </button>
      )}

      {/* AI lookup result */}
      {showAI && (
        <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--bg-tertiary)' }}>
          <div className="flex items-center gap-1 text-xs mb-1" style={{ color: 'var(--accent)' }}>
            <Sparkles className="w-3 h-3" />
            AI Response
          </div>
          {aiLoading && (
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Looking up...
            </div>
          )}
          {aiLookup && (
            <>
              <div className="space-y-1.5 text-sm">
                {aiLookup.reading && (
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Reading:</span>
                    <span className="ml-2">{aiLookup.reading}</span>
                  </div>
                )}
                {aiLookup.meaning && (
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Meaning:</span>
                    <span className="ml-2">{aiLookup.meaning}</span>
                  </div>
                )}
                {aiLookup.furigana && (
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Furigana:</span>
                    <span className="ml-2">{aiLookup.furigana}</span>
                  </div>
                )}
                {aiLookup.part_of_speech && (
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Part of Speech:</span>
                    <span className="ml-2">{aiLookup.part_of_speech}</span>
                  </div>
                )}
                {aiLookup.example && (
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Example:</span>
                    <span className="ml-2">{aiLookup.example}</span>
                  </div>
                )}
                {aiLookup.notes && (
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Notes:</span>
                    <span className="ml-2">{aiLookup.notes}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <style>{`
        .word-tooltip {
          background: var(--bg-secondary);
          border: 1px solid var(--bg-tertiary);
          border-radius: 8px;
          padding: 12px 16px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
          min-width: 220px;
          max-width: 300px;
        }
      `}</style>
    </div>
  );
}

export function Reading() {
  const { t } = useTranslation();
  const [storyList, setStoryList] = useState<SavedStory[]>([]);
  const [selectedStory, setSelectedStory] = useState<SavedStory | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingStoryId, setEditingStoryId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [deletingStory, setDeletingStory] = useState<SavedStory | null>(null);

  // Active lookup fields (can be toggled by user)
  const [activeLookupFields, setActiveLookupFields] = useState<string[]>([]);

  const [tooltip, setTooltip] = useState<{
    word: string;
    isVocab: boolean;
    fields: Record<string, string> | null;
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    loadStories();

    const params = new URLSearchParams(window.location.search);
    const storyId = params.get('story');
    if (storyId) {
      loadStory(parseInt(storyId, 10));
    }
  }, []);

  // Save lookup fields to story when they change
  useEffect(() => {
    if (!selectedStory) return;

    // Don't save on initial load - only when user toggles
    const currentFields = JSON.stringify(activeLookupFields.sort());
    const storyFields = JSON.stringify((selectedStory.lookup_fields || []).sort());
    if (currentFields === storyFields) return;

    const saveTimeout = setTimeout(async () => {
      try {
        await stories.update(selectedStory.id, { lookup_fields: activeLookupFields });
      } catch (err) {
        console.error('Failed to save lookup fields:', err);
      }
    }, 500); // Debounce to avoid too many API calls

    return () => clearTimeout(saveTimeout);
  }, [activeLookupFields, selectedStory]);

  const loadStories = async () => {
    setLoading(true);
    try {
      const data = await stories.list();
      setStoryList(data.stories);
    } catch (err) {
      console.error('Failed to load stories:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadStory = async (id: number) => {
    try {
      const data = await stories.get(id);
      setSelectedStory(data.story);
      // Initialize active lookup fields from story
      setActiveLookupFields(data.story.lookup_fields || []);
      window.history.pushState({}, '', `/reading?story=${id}`);
    } catch (err) {
      console.error('Failed to load story:', err);
    }
  };

  const confirmDelete = async () => {
    if (!deletingStory) return;
    try {
      await stories.delete(deletingStory.id);
      setStoryList((prev) => prev.filter((s) => s.id !== deletingStory.id));
      if (selectedStory?.id === deletingStory.id) {
        setSelectedStory(null);
        window.history.replaceState({}, '', '/reading');
      }
      setDeletingStory(null);
    } catch (err) {
      console.error('Failed to delete story:', err);
      setDeletingStory(null);
    }
  };

  const handleRename = async (id: number, name: string) => {
    if (!name.trim()) return;
    try {
      await stories.update(id, { name: name.trim() });
      setStoryList((prev) =>
        prev.map((s) => (s.id === id ? { ...s, name: name.trim() } : s))
      );
      if (selectedStory?.id === id) {
        setSelectedStory((prev) => (prev ? { ...prev, name: name.trim() } : null));
      }
      setEditingStoryId(null);
      setNewName('');
    } catch (err) {
      console.error('Failed to rename story:', err);
    }
  };

  const startEditing = (story: SavedStory, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setEditingStoryId(story.id);
    setNewName(story.name);
  };

  const handleWordClick = useCallback(
    (word: string, isVocab: boolean, rect: DOMRect) => {
      const wordData = selectedStory?.word_data || {};
      const data = wordData[word] || wordData[word.toLowerCase()];
      const fields = data ? data.fields : null;

      setTooltip({
        word,
        isVocab,
        fields,
        position: { x: rect.left + rect.width / 2, y: rect.top },
      });
    },
    [selectedStory]
  );

  const closeTooltip = useCallback(() => {
    setTooltip(null);
  }, []);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Header skeleton */}
        <div className="flex items-center justify-between">
          <div className="skeleton h-8 w-32"></div>
          <div className="skeleton h-9 w-24 rounded"></div>
        </div>

        {/* Story grid skeleton */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card card-hover">
              <div className="skeleton h-6 w-40 mb-3"></div>
              <div className="skeleton h-4 w-full mb-2"></div>
              <div className="skeleton h-4 w-3/4 mb-4"></div>
              <div className="flex justify-between items-center">
                <div className="skeleton h-4 w-24"></div>
                <div className="flex gap-1">
                  <div className="skeleton h-8 w-8 rounded"></div>
                  <div className="skeleton h-8 w-8 rounded"></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Story detail view
  if (selectedStory) {
    const words = selectedStory.words || [];
    const lookupLanguage = selectedStory.lookup_language || 'auto';

    // Get available fields from story's word_data (actual fields from the deck)
    const fieldSet = new Set<string>();
    if (selectedStory?.word_data) {
      for (const wordData of Object.values(selectedStory.word_data)) {
        if (wordData.fields) {
          Object.keys(wordData.fields).forEach(field => fieldSet.add(field));
        }
      }
    }
    const availableFields = Array.from(fieldSet).sort();

    const toggleLookupField = (field: string) => {
      setActiveLookupFields(prev =>
        prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]
      );
    };

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => {
              setSelectedStory(null);
              setEditingStoryId(null);
              setActiveLookupFields([]);
              window.history.replaceState({}, '', '/reading');
            }}
            className="btn btn-secondary flex items-center gap-2"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>

          {editingStoryId === selectedStory.id ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="input flex-1"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename(selectedStory.id, newName);
                  if (e.key === 'Escape') setEditingStoryId(null);
                }}
              />
              <button onClick={() => handleRename(selectedStory.id, newName)} className="btn btn-primary p-2">
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => setEditingStoryId(null)} className="btn btn-secondary p-2">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <h2 className="text-xl font-bold flex-1">{selectedStory.name}</h2>
          )}

          {editingStoryId !== selectedStory.id && (
            <div className="flex items-center gap-2">
              <button onClick={() => startEditing(selectedStory)} className="btn btn-secondary p-2" title="Rename">
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setDeletingStory(selectedStory)}
                className="btn btn-secondary p-2"
                style={{ color: 'var(--error)' }}
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <div className="flex items-center gap-1">
            <Clock className="w-4 h-4" />
            {formatDate(selectedStory.created_at)}
          </div>
          {selectedStory.provider && selectedStory.model && (
            <div className="flex items-center gap-1">
              <Cpu className="w-4 h-4" />
              {selectedStory.provider} / {selectedStory.model}
            </div>
          )}
          {selectedStory.deck_name && (
            <div className="flex items-center gap-1">
              <FileText className="w-4 h-4" />
              {selectedStory.deck_name}
            </div>
          )}
          <div className="flex items-center gap-1">
            {words.length} vocabulary words
          </div>
        </div>

        {/* Lookup fields toggle */}
        <div className="card">
          <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>AI Lookup Fields</h3>
          <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
            Select which fields AI should return when looking up non-vocabulary words
          </p>
          <div className="flex flex-wrap gap-2">
            {availableFields.map(field => (
              <button
                key={field}
                onClick={() => toggleLookupField(field)}
                className={`text-xs px-3 py-1.5 rounded transition-colors ${
                  activeLookupFields.includes(field)
                    ? 'bg-(--accent) text-white'
                    : 'bg-(--bg-tertiary) hover:bg-(--bg-tertiary)/80'
                }`}
              >
                {field}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          {selectedStory.content ? (
            <StoryContent
              content={selectedStory.content}
              words={words}
              onWordClick={handleWordClick}
            />
          ) : (
            <p style={{ color: 'var(--text-secondary)' }}>Story content not available.</p>
          )}
        </div>

        {tooltip && (
          <WordTooltip
            word={tooltip.word}
            isVocab={tooltip.isVocab}
            fields={tooltip.fields}
            lookupFields={activeLookupFields}
            lookupLanguage={lookupLanguage}
            position={tooltip.position}
            onClose={closeTooltip}
          />
        )}

        {/* Delete Confirmation Modal */}
        {deletingStory && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="card max-w-md w-full mx-4">
              <h3 className="text-lg font-semibold mb-2">Delete Story</h3>
              <p className="text-(--text-secondary) mb-4">
                Are you sure you want to delete "<span className="text-white">{deletingStory.name}</span>"?
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setDeletingStory(null)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  className="btn btn-error"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Story list view
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <h2 className="text-xl font-bold">{t('reading.title')}</h2>

      <p style={{ color: 'var(--text-secondary)' }}>
        Your saved stories for vocabulary practice. Click any word to see its meaning.
      </p>

      {storyList.length === 0 ? (
        <div className="card text-center py-12">
          <BookOpen className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-secondary)' }} />
          <p style={{ color: 'var(--text-secondary)' }}>No stories yet.</p>
          <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
            Generate your first story in the Story Generator!
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {storyList.map((story) => (
            <div
              key={story.id}
              className="card card-hover cursor-pointer relative group"
              onClick={() => {
                if (editingStoryId !== story.id) {
                  loadStory(story.id);
                }
              }}
            >
              {/* Edit/Delete buttons - always visible in top right */}
              <div className="absolute top-3 right-3 flex items-center gap-1">
                <button
                  onClick={(e) => startEditing(story, e)}
                  className="icon-btn"
                  title="Rename"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeletingStory(story);
                  }}
                  className="icon-btn icon-btn-danger"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {editingStoryId === story.id ? (
                <div className="flex items-center gap-2 pr-16" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="input flex-1 text-sm"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(story.id, newName);
                      if (e.key === 'Escape') setEditingStoryId(null);
                    }}
                  />
                  <button onClick={() => handleRename(story.id, newName)} className="btn btn-primary p-1.5">
                    <Check className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <h3 className="font-semibold line-clamp-2 pr-20 group-hover-accent transition-colors">
                  {story.name}
                </h3>
              )}

              <div className="mt-3 space-y-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {new Date(story.created_at).toLocaleDateString()}
                </div>
                {story.provider && (
                  <div className="flex items-center gap-1">
                    <Cpu className="w-3 h-3" />
                    {story.provider}
                  </div>
                )}
                {story.deck_name && (
                  <div className="flex items-center gap-1">
                    <FileText className="w-3 h-3" />
                    <span className="truncate">{story.deck_name}</span>
                  </div>
                )}
              </div>

              {story.style && (
                <div className="mt-3">
                  <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)' }}>
                    {story.style}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingStory && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-2">Delete Story</h3>
            <p className="text-(--text-secondary) mb-4">
              Are you sure you want to delete "<span className="text-white">{deletingStory.name}</span>"?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeletingStory(null)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="btn btn-error"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
