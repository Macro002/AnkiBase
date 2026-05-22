import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, RotateCcw, ThumbsDown, ThumbsUp, Check, Volume2, Undo2, X } from 'lucide-react';
import { decks, cards, media, type Card } from '../api';

// Process card HTML to load images via media API
function processCardHtml(html: string, mediaCache: Map<string, string>): string {
  // Replace img src with cached data URLs
  let processed = html.replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, (match, src) => {
    // Skip if already a data URL or http URL
    if (src.startsWith('data:') || src.startsWith('http')) return match;

    const cached = mediaCache.get(src);
    if (cached) {
      return match.replace(src, cached);
    }
    // Return with API URL as fallback
    return match.replace(src, `/api/media/${encodeURIComponent(src)}`);
  });

  // Replace [anki:play:a:N] and [anki:play:q:N] tags with placeholder divs
  processed = processed.replace(/\[anki:play:[aq]:(\d+)\]/g, (_match, index) => {
    return `<div class="audio-button-slot" data-audio-index="${index}"></div>`;
  });

  return processed;
}

// Split HTML into parts around audio button placeholders
function splitHtmlForAudioButtons(html: string): Array<{ type: 'html' | 'audio'; content: string; audioIndex?: number }> {
  const parts: Array<{ type: 'html' | 'audio'; content: string; audioIndex?: number }> = [];
  const regex = /<div class="audio-button-slot" data-audio-index="(\d+)"><\/div>/g;

  let lastIndex = 0;
  let matchResult;

  while ((matchResult = regex.exec(html)) !== null) {
    // Add HTML before this audio button
    if (matchResult.index > lastIndex) {
      parts.push({ type: 'html', content: html.substring(lastIndex, matchResult.index) });
    }

    // Add audio button marker
    parts.push({ type: 'audio', content: '', audioIndex: parseInt(matchResult[1], 10) });

    lastIndex = regex.lastIndex;
  }

  // Add remaining HTML
  if (lastIndex < html.length) {
    parts.push({ type: 'html', content: html.substring(lastIndex) });
  }

  // If no audio buttons found, return the whole HTML as one part
  if (parts.length === 0) {
    parts.push({ type: 'html', content: html });
  }

  return parts;
}

// Extract sound files from card HTML or field value
function extractSounds(text: string): string[] {
  const sounds: string[] = [];
  // Match [sound:filename.mp3] format (standard Anki format)
  const regex = /\[sound:([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    sounds.push(match[1]);
  }
  return sounds;
}

// Get all sounds from a card (checking both rendered HTML and raw fields)
function getCardSounds(card: Card, side: 'question' | 'answer'): string[] {
  const sounds = new Set<string>();

  // Check rendered HTML
  const html = side === 'question' ? card.question : card.answer;
  extractSounds(html).forEach(s => sounds.add(s));

  // Also check raw field values (sounds might be stripped from rendered HTML)
  if (card.fields) {
    Object.values(card.fields).forEach(field => {
      if (field.value) {
        extractSounds(field.value).forEach(s => sounds.add(s));
      }
    });
  }

  return Array.from(sounds);
}

export function Study() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [deckName, setDeckName] = useState('');

  const [currentCard, setCurrentCard] = useState<Card | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [currentNumber, setCurrentNumber] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [error, setError] = useState('');
  const [answering, setAnswering] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [sessionStats, setSessionStats] = useState({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
  const [mediaCache] = useState(() => new Map<string, string>());
  const [undoCount, setUndoCount] = useState(0);
  const [hoverSide, setHoverSide] = useState<'left' | 'right' | null>(null);
  const [answerFeedback, setAnswerFeedback] = useState<{ type: 'wrong' | 'right'; ease: number } | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [autoPlayCompleted, setAutoPlayCompleted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stopAudioFlag = useRef(false);

  // Track mouse position for side hover effects
  const handleCardMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!showAnswer || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    const threshold = width * 0.3; // 30% from each side

    if (x < threshold) {
      setHoverSide('left');
    } else if (x > width - threshold) {
      setHoverSide('right');
    } else {
      setHoverSide(null);
    }
  };

  // Load and cache media for a card (async, non-blocking)
  const loadCardMedia = useCallback(async (card: Card) => {
    // Find all image sources in question and answer
    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    const sources: string[] = [];

    let match;
    const questionCopy = card.question;
    const answerCopy = card.answer;

    while ((match = imgRegex.exec(questionCopy)) !== null) {
      if (!match[1].startsWith('data:') && !match[1].startsWith('http')) {
        sources.push(match[1]);
      }
    }
    imgRegex.lastIndex = 0;
    while ((match = imgRegex.exec(answerCopy)) !== null) {
      if (!match[1].startsWith('data:') && !match[1].startsWith('http')) {
        sources.push(match[1]);
      }
    }

    // Load images that aren't cached
    for (const src of sources) {
      if (!mediaCache.has(src)) {
        try {
          const result = await media.get(src);
          if (result.data) {
            const ext = src.split('.').pop()?.toLowerCase() || 'jpg';
            const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
            mediaCache.set(src, `data:${mimeType};base64,${result.data}`);
          }
        } catch (err) {
          console.error('Failed to load media:', src, err);
        }
      }
    }
  }, [mediaCache]);

  // Play sounds from card sequentially with delay
  const playSounds = useCallback(async (soundFiles: string[], isAutoPlay = false) => {
    stopAudioFlag.current = false; // Reset flag when starting playback
    setIsAudioPlaying(true);

    for (let i = 0; i < soundFiles.length; i++) {
      // Check if we should stop
      if (stopAudioFlag.current) break;

      const sound = soundFiles[i];
      try {
        const result = await media.get(sound);
        if (result.data && !stopAudioFlag.current) {
          const ext = sound.split('.').pop()?.toLowerCase() || 'mp3';
          const mimeType = ext === 'ogg' ? 'audio/ogg' : ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
          const audio = new Audio(`data:${mimeType};base64,${result.data}`);
          audioRef.current = audio;

          // Wait for audio to finish playing
          await new Promise<void>((resolve) => {
            audio.onended = () => resolve();
            audio.onerror = () => resolve();
            audio.play().catch(() => resolve());
          });

          // Check if we should stop before delay
          if (stopAudioFlag.current) break;

          // Add 0.5s delay between sounds (except after last sound)
          if (i < soundFiles.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      } catch (err) {
        console.error('Failed to play sound:', sound, err);
      }
    }

    setIsAudioPlaying(false);
    if (isAutoPlay) {
      setAutoPlayCompleted(true);
    }
  }, []);

  const loadNextCard = useCallback(async (incrementCount = false) => {
    if (!deckName) return;

    // Stop all audio immediately
    stopAudioFlag.current = true;
    setIsAudioPlaying(false);
    setAutoPlayCompleted(false);

    // Stop current audio element
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    // Stop all HTML5 audio elements on the page
    document.querySelectorAll('audio').forEach(audio => {
      audio.pause();
      audio.currentTime = 0;
    });

    setError('');
    try {
      const data = await decks.getNextCard(deckName);
      setCurrentCard(data.card);
      setRemaining(data.remaining);
      setShowAnswer(false);
      setInitialLoad(false);

      // Update current number (increment when answering, reset when loading fresh)
      if (incrementCount) {
        setCurrentNumber(prev => prev + 1);
      } else if (data.card) {
        // First load or reload - set to 1
        setCurrentNumber(1);
      }

      // Preload media asynchronously (don't block UI)
      if (data.card) {
        loadCardMedia(data.card);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load card');
      setInitialLoad(false);
    }
  }, [deckName, loadCardMedia]);

  useEffect(() => {
    if (!id) return;
    decks.list().then(data => {
      const entry = Object.entries(data.decks).find(([, v]) => v === Number(id));
      if (entry) setDeckName(entry[0]);
    });
  }, [id]);

  useEffect(() => {
    setInitialLoad(true);
    loadNextCard();
  }, [loadNextCard]);

  const handleShowAnswer = useCallback(() => {
    setShowAnswer(true);
    setAutoPlayCompleted(false);
    // Play answer sounds automatically
    if (currentCard) {
      const answerSounds = getCardSounds(currentCard, 'answer');
      if (answerSounds.length > 0) {
        playSounds(answerSounds, true); // true = isAutoPlay
      } else {
        // No sounds to play, mark auto-play as completed immediately
        setAutoPlayCompleted(true);
      }
    }
  }, [currentCard, playSounds]);

  const handleAnswer = useCallback(async (ease: 1 | 2 | 3 | 4) => {
    if (!currentCard || answering) return;

    setAnswering(true);

    // Show feedback (X for wrong, checkmark for right)
    const feedbackType = ease <= 2 ? 'wrong' : 'right';
    setAnswerFeedback({ type: feedbackType, ease });

    // Fade out feedback after 800ms
    setTimeout(() => setAnswerFeedback(null), 800);

    try {
      await cards.answer(currentCard.cardId, ease);

      // Update stats
      const statKey = ease === 1 ? 'again' : ease === 2 ? 'hard' : ease === 3 ? 'good' : 'easy';
      setSessionStats((prev) => ({
        ...prev,
        reviewed: prev.reviewed + 1,
        [statKey]: prev[statKey] + 1,
      }));

      // Load next card (increment count)
      await loadNextCard(true);
      setUndoCount(prev => prev + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to answer card');
    } finally {
      setAnswering(false);
    }
  }, [currentCard, answering, loadNextCard]);

  // Undo last answer
  const handleUndo = useCallback(async () => {
    try {
      await cards.undo();
      setUndoCount(prev => Math.max(0, prev - 1));
      // Reload to get the undone card back
      await loadNextCard();
    } catch (err) {
      console.error('Undo failed:', err);
    }
  }, [loadNextCard]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (!showAnswer && e.code === 'Space') {
        e.preventDefault();
        handleShowAnswer();
      } else if (showAnswer) {
        if (e.key === '1') handleAnswer(1);
        else if (e.key === '2') handleAnswer(2);
        else if (e.key === '3') handleAnswer(3);
        else if (e.key === '4') handleAnswer(4);
      }
      // Undo with Ctrl+Z
      if (e.key === 'z' && e.ctrlKey && undoCount > 0) {
        e.preventDefault();
        handleUndo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAnswer, handleShowAnswer, handleAnswer, undoCount, handleUndo]);

  // Format interval for display
  const formatInterval = (card: Card, ease: number): string => {
    const interval = card.interval || 0;
    const factor = (card.factor || 2500) / 1000;

    let nextInterval: number;
    if (card.type === 0) {
      // New card
      switch (ease) {
        case 1: return '<1m';
        case 2: return '<6m';
        case 3: return '<10m';
        case 4: return '4d';
      }
    } else if (card.type === 1 || interval < 1) {
      // Learning card
      switch (ease) {
        case 1: return '<1m';
        case 2: return '<6m';
        case 3: return '1d';
        case 4: return '4d';
      }
    } else {
      // Review card
      switch (ease) {
        case 1: nextInterval = 1; break;
        case 2: nextInterval = Math.max(1, interval * 1.2); break;
        case 3: nextInterval = Math.max(1, interval * factor); break;
        case 4: nextInterval = Math.max(1, interval * factor * 1.3); break;
        default: nextInterval = interval;
      }

      if (nextInterval < 1) return '<1d';
      if (nextInterval < 30) return `${Math.round(nextInterval)}d`;
      if (nextInterval < 365) return `${Math.round(nextInterval / 30)}mo`;
      return `${(nextInterval / 365).toFixed(1)}y`;
    }
    return '';
  };

  if (!deckName) {
    return (
      <div className="card text-center">
        <p className="text-(--text-secondary)">{t('study.selectDeck')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card text-center">
        <p className="text-(--error)">{error}</p>
        <button onClick={() => loadNextCard()} className="btn btn-primary mt-4">
          Retry
        </button>
      </div>
    );
  }

  // Don't show "Session Complete" on initial load - just show nothing while loading first card
  if (!currentCard) {
    if (initialLoad) {
      return null;
    }

    return (
      <div className="card text-center">
        <h2 className="text-2xl font-bold mb-4">Session Complete!</h2>
        <p className="text-(--text-secondary) mb-4">
          You've reviewed all due cards in <strong>{deckName}</strong>
        </p>

        {sessionStats.reviewed > 0 && (
          <div className="flex justify-center gap-4 mb-6 text-sm">
            <span>Reviewed: {sessionStats.reviewed}</span>
            <span className="text-red-400">Again: {sessionStats.again}</span>
            <span className="text-orange-400">Hard: {sessionStats.hard}</span>
            <span className="text-green-400">Good: {sessionStats.good}</span>
            <span className="text-(--accent)">Easy: {sessionStats.easy}</span>
          </div>
        )}

        <button onClick={() => loadNextCard()} className="btn btn-primary">
          Check for more cards
        </button>
      </div>
    );
  }

  // Process card HTML with cached media
  const questionHtml = processCardHtml(currentCard.question, mediaCache);
  const answerHtml = processCardHtml(currentCard.answer, mediaCache);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Progress */}
      <div className="flex justify-between items-center text-sm">
        <span className="text-(--text-secondary)">{deckName}</span>
        <div className="flex items-center gap-3">
          {undoCount > 0 && (
            <button
              onClick={handleUndo}
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-(--bg-tertiary) hover-bg-accent transition-colors text-(--text-secondary) hover-text-primary"
              title={`Undo last answer (Ctrl+Z) - ${undoCount} available`}
            >
              <Undo2 className="w-4 h-4" />
              <span className="text-xs font-medium">Undo ({undoCount})</span>
            </button>
          )}
          <span className="text-(--text-secondary)">
            {currentNumber} / {remaining}
          </span>
        </div>
      </div>

      {/* Card */}
      <div
        ref={cardRef}
        onClick={() => !showAnswer && handleShowAnswer()}
        onMouseMove={handleCardMouseMove}
        onMouseLeave={() => setHoverSide(null)}
        className={`card min-h-[300px] flex flex-col relative overflow-hidden ${!showAnswer ? 'cursor-pointer' : ''}`}
      >
        {/* Side shimmer effects - clickable for actions */}
        {showAnswer && (
          <>
            <div
              onClick={() => handleAnswer(2)}
              className={`absolute inset-y-0 left-0 w-1/3 cursor-pointer transition-opacity duration-200 ${
                hoverSide === 'left' ? 'opacity-20' : 'opacity-0'
              }`}
              style={{
                background: 'linear-gradient(to right, #ca8a04, transparent)',
              }}
            />
            <div
              onClick={() => handleAnswer(3)}
              className={`absolute inset-y-0 right-0 w-1/3 cursor-pointer transition-opacity duration-200 ${
                hoverSide === 'right' ? 'opacity-20' : 'opacity-0'
              }`}
              style={{
                background: 'linear-gradient(to left, #16a34a, transparent)',
              }}
            />
          </>
        )}

        {/* Question */}
        <div className="flex-1 flex flex-col items-center justify-center p-4 relative z-10">
          <div
            className="anki-content text-center"
            dangerouslySetInnerHTML={{ __html: questionHtml }}
          />

        </div>

        {/* Divider */}
        {showAnswer && <hr className="border-(--bg-tertiary)" />}

        {/* Answer */}
        {showAnswer && (
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            {(() => {
              const answerSounds = getCardSounds(currentCard, 'answer');
              const htmlParts = splitHtmlForAudioButtons(answerHtml);

              // Group consecutive audio buttons together
              const groupedParts: Array<{ type: 'html' | 'audio-group'; content?: string; audioIndices?: number[] }> = [];
              let currentAudioGroup: number[] = [];

              htmlParts.forEach((part) => {
                if (part.type === 'audio' && part.audioIndex !== undefined) {
                  currentAudioGroup.push(part.audioIndex);
                } else {
                  // Check if this HTML part is only whitespace
                  const isWhitespaceOnly = part.type === 'html' && part.content?.trim() === '';

                  // Only break audio group if we encounter non-whitespace HTML
                  if (!isWhitespaceOnly) {
                    // If we have accumulated audio buttons, add them as a group
                    if (currentAudioGroup.length > 0) {
                      groupedParts.push({ type: 'audio-group', audioIndices: currentAudioGroup });
                      currentAudioGroup = [];
                    }
                    // Add HTML part
                    if (part.type === 'html') {
                      groupedParts.push({ type: 'html', content: part.content });
                    }
                  }
                  // If it's whitespace only, we ignore it and continue building the audio group
                }
              });

              // Don't forget any trailing audio buttons
              if (currentAudioGroup.length > 0) {
                groupedParts.push({ type: 'audio-group', audioIndices: currentAudioGroup });
              }

              return groupedParts.map((group, index) => {
                if (group.type === 'html') {
                  return (
                    <div
                      key={index}
                      className="anki-content text-center"
                      dangerouslySetInnerHTML={{ __html: group.content || '' }}
                    />
                  );
                } else if (group.type === 'audio-group' && group.audioIndices) {
                  // Render all audio buttons in this group side-by-side
                  const isDisabled = isAudioPlaying || !autoPlayCompleted;
                  return (
                    <div key={index} className="flex gap-3 my-3">
                      {group.audioIndices.map((audioIndex) => {
                        const soundFile = answerSounds[audioIndex];
                        if (soundFile) {
                          return (
                            <button
                              key={audioIndex}
                              onClick={() => !isDisabled && playSounds([soundFile], false)}
                              disabled={isDisabled}
                              className={`flex flex-col items-center justify-center w-16 h-16 rounded-lg transition-all duration-200 ${
                                isDisabled
                                  ? 'bg-(--bg-secondary) opacity-50 cursor-not-allowed'
                                  : 'bg-(--bg-tertiary) hover-bg-accent hover:scale-110'
                              }`}
                              title={isDisabled ? 'Wait for audio to finish' : `Play audio ${audioIndex + 1}`}
                            >
                              <Volume2 className="w-6 h-6" />
                              <span className="text-xs mt-1">{audioIndex + 1}</span>
                            </button>
                          );
                        }
                        return null;
                      })}
                    </div>
                  );
                }
                return null;
              });
            })()}
          </div>
        )}

        {/* Answer Feedback Overlay */}
        {answerFeedback && (
          <div className="absolute top-4 right-4 z-50 pointer-events-none animate-fade-out">
            <div className="rounded-full p-2" style={{ background: 'rgba(233, 69, 96, 0.2)' }}>
              {answerFeedback.type === 'wrong' ? (
                <X className="w-8 h-8" style={{ color: 'var(--accent)' }} strokeWidth={2.5} />
              ) : (
                <Check className="w-8 h-8" style={{ color: 'var(--accent)' }} strokeWidth={2.5} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      {!showAnswer ? (
        <button
          onClick={handleShowAnswer}
          className="btn btn-primary w-full flex items-center justify-center gap-2 py-3"
        >
          <Eye className="w-5 h-5" />
          {t('study.showAnswer')}
          <kbd className="ml-2 px-2 py-0.5 bg-white/10 rounded text-xs">Space</kbd>
        </button>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          <button
            onClick={() => handleAnswer(1)}
            disabled={answering}
            className="btn btn-error flex flex-col items-center py-3"
          >
            <RotateCcw className="w-5 h-5" />
            <span className="text-xs font-medium">{t('study.again')}</span>
            <span className="text-xs opacity-70">{formatInterval(currentCard, 1)}</span>
          </button>
          <button
            onClick={() => handleAnswer(2)}
            disabled={answering}
            className="btn btn-warning flex flex-col items-center py-3"
          >
            <ThumbsDown className="w-5 h-5" />
            <span className="text-xs font-medium">{t('study.hard')}</span>
            <span className="text-xs opacity-70">{formatInterval(currentCard, 2)}</span>
          </button>
          <button
            onClick={() => handleAnswer(3)}
            disabled={answering}
            className="btn btn-success flex flex-col items-center py-3"
          >
            <ThumbsUp className="w-5 h-5" />
            <span className="text-xs font-medium">{t('study.good')}</span>
            <span className="text-xs opacity-70">{formatInterval(currentCard, 3)}</span>
          </button>
          <button
            onClick={() => handleAnswer(4)}
            disabled={answering}
            className="btn bg-blue-600 text-white flex flex-col items-center py-3 hover-bg-blue"
          >
            <Check className="w-5 h-5" />
            <span className="text-xs font-medium">{t('study.easy')}</span>
            <span className="text-xs opacity-70">{formatInterval(currentCard, 4)}</span>
          </button>
        </div>
      )}

      {/* Card CSS */}
      {currentCard.css && <style>{currentCard.css}</style>}

      {/* Override custom deck styling to maintain consistent AnkiBase theme */}
      <style>{`
        /* Override deck CSS that targets .card class */
        .card.card {
          background: var(--bg-secondary) !important;
          background-color: var(--bg-secondary) !important;
          background-image: none !important;
        }

        /* Aggressively reset ALL backgrounds and colors in card content */
        .anki-content,
        .anki-content *,
        .anki-content div,
        .anki-content span,
        .anki-content p,
        .anki-content table,
        .anki-content td,
        .anki-content tr,
        .anki-content th,
        .anki-content center,
        #qa {
          background: transparent !important;
          background-color: transparent !important;
          background-image: none !important;
          color: var(--text-primary) !important;
        }

        /* Reset font sizing */
        .anki-content {
          font-size: 1.25rem !important;
          line-height: 1.6 !important;
        }

        /* Ensure images work properly */
        .anki-content img {
          background: transparent !important;
          max-width: 400px !important;
          height: auto !important;
          display: block !important;
          margin: 1rem auto !important;
        }

        /* SVG sizing - prevent oversized SVGs ONLY in card content */
        .anki-content.anki-content svg,
        .anki-content.anki-content div svg,
        .anki-content.anki-content span svg,
        .anki-content.anki-content center svg,
        .anki-content svg[width],
        .anki-content svg[height] {
          max-width: 120px !important;
          max-height: 120px !important;
          width: 120px !important;
          height: 120px !important;
          display: block !important;
          margin: 1rem auto !important;
        }

        /* Audio/sound buttons - maximum specificity for white text */
        .anki-content.anki-content button,
        .anki-content.anki-content [onclick],
        .anki-content.anki-content a.replay-button,
        .anki-content button[style],
        .anki-content [onclick][style] {
          background: var(--bg-tertiary) !important;
          color: #ffffff !important;
          border: 1px solid var(--bg-tertiary) !important;
          padding: 0.5rem 1rem !important;
          border-radius: 0.5rem !important;
          cursor: pointer !important;
          font-weight: 500 !important;
        }

        .anki-content.anki-content button *,
        .anki-content.anki-content [onclick] *,
        .anki-content.anki-content a.replay-button *,
        .anki-content.anki-content button span,
        .anki-content.anki-content [onclick] span,
        .anki-content button span[style],
        .anki-content [onclick] span[style] {
          color: #ffffff !important;
          background: transparent !important;
          background-color: transparent !important;
        }

        .anki-content.anki-content button:hover,
        .anki-content.anki-content [onclick]:hover {
          background: var(--accent) !important;
          color: #ffffff !important;
        }

        .anki-content.anki-content button:hover *,
        .anki-content.anki-content [onclick]:hover * {
          color: #ffffff !important;
        }

        /* Maintain readability for links */
        .anki-content a {
          color: var(--accent) !important;
          text-decoration: underline !important;
        }

        /* HR lines should be visible */
        .anki-content hr {
          border-color: var(--bg-tertiary) !important;
          opacity: 0.3 !important;
        }

        /* Code blocks */
        .anki-content code,
        .anki-content pre {
          background: var(--bg-tertiary) !important;
          color: var(--text-primary) !important;
          padding: 0.2em 0.4em !important;
          border-radius: 3px !important;
        }
      `}</style>
    </div>
  );
}
