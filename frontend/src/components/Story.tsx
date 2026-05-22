import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, BookOpen, Wand2, Settings2, Key, Trash2, Check, Eye, EyeOff, ExternalLink, Cpu, Info, Pencil } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { decks, story, settings } from '../api';
import type { ProviderInfo, CardCategory, DeckWordsResponse, WordData } from '../api';

interface DeckOption {
  name: string;
  id: number;
}

const STYLES = [
  { value: 'casual', label: 'Casual' },
  { value: 'formal', label: 'Formal' },
  { value: 'funny', label: 'Funny' },
  { value: 'dramatic', label: 'Dramatic' },
  { value: 'educational', label: 'Educational' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'custom', label: 'Custom...' },
];

const LENGTHS = [
  { value: 'auto', label: 'Auto (based on word count)' },
  { value: 'short', label: 'Short (~200 words)' },
  { value: 'medium', label: 'Medium (~500 words)' },
  { value: 'long', label: 'Long (~1000 words)' },
];

const CATEGORY_INFO: Record<CardCategory, { label: string; description: string }> = {
  new: { label: 'New', description: 'Never studied' },
  learning: { label: 'Learning', description: 'Currently learning' },
  relearning: { label: 'Relearning', description: 'Failed, relearning' },
  young: { label: 'Young', description: 'Interval < 21 days' },
  mature: { label: 'Mature', description: 'Interval >= 21 days' },
  suspended: { label: 'Suspended', description: 'Manually suspended' },
  buried: { label: 'Buried', description: 'Temporarily buried' },
  unknown: { label: 'Unknown', description: 'Unknown state' },
};

// Word selection modes
type SelectionMode = 'manual' | 'weighted';

interface WeightSettings {
  learning: number;
  relearning: number;
  young: number;
  mature: number;
  new: number;
}

const DEFAULT_WEIGHTS: WeightSettings = {
  learning: 5,
  relearning: 4,
  young: 2,
  mature: 1,
  new: 0,
};

export function Story() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [deckList, setDeckList] = useState<DeckOption[]>([]);
  const [selectedDeck, setSelectedDeck] = useState('');
  const [wordsData, setWordsData] = useState<DeckWordsResponse | null>(null);
  const [selectedWords, setSelectedWords] = useState<string[]>([]);
  const [customWords, setCustomWords] = useState('');
  const [style, setStyle] = useState('casual');
  const [customInstructions, setCustomInstructions] = useState('');
  const [length, setLength] = useState('auto');
  const [language, setLanguage] = useState('auto');
  const [customLanguage, setCustomLanguage] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('');
  const [storyName, setStoryName] = useState('');
  const [generatedStory, setGeneratedStory] = useState('');
  const [generatedStoryId, setGeneratedStoryId] = useState<number | null>(null);
  const [providerUsed, setProviderUsed] = useState<string | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingWords, setLoadingWords] = useState(false);
  const [error, setError] = useState('');

  // Field selection
  const [availableFields, setAvailableFields] = useState<string[]>([]);
  const [selectedField, setSelectedField] = useState('');
  const [fieldUsed, setFieldUsed] = useState<string | null>(null);

  // Lookup fields (for Reading page)
  const [lookupFields, setLookupFields] = useState<string[]>([]);
  const [lookupLanguage, setLookupLanguage] = useState('auto');
  const [customLookupLanguage, setCustomLookupLanguage] = useState('');

  // Word selection mode
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('weighted');
  const [weights, setWeights] = useState<WeightSettings>(DEFAULT_WEIGHTS);
  const [targetWordCount, setTargetWordCount] = useState(20);

  // Provider/Model selection
  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({});
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [dynamicModels, setDynamicModels] = useState<Record<string, { id: string; name: string }[]>>({});
  const [loadingModels, setLoadingModels] = useState(false);

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [isEnvKey, setIsEnvKey] = useState<Record<string, boolean>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showKeyValue, setShowKeyValue] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{ provider: string; providerName: string } | null>(null);

  // Copied state (track which provider key was just copied)
  const [copiedProvider, setCopiedProvider] = useState<string | null>(null);

  // Load initial data
  useEffect(() => {
    const loadData = async () => {
      try {
        const [deckData, providerData, apiKeyData] = await Promise.all([
          decks.list(),
          settings.getProviders(),
          settings.getApiKeys(),
        ]);

        const list = Object.entries(deckData.decks).map(([name, id]) => ({ name, id }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setDeckList(list);
        setProviders(providerData.providers);
        setConfiguredKeys(apiKeyData.configured);
        setApiKeys(apiKeyData.keys);
        setIsEnvKey(apiKeyData.is_env_key || {});
      } catch (err) {
        console.error('Failed to load data:', err);
      }
    };
    loadData();
  }, []);

  useEffect(() => {
    if (showSettings) {
      loadApiKeys();
    }
  }, [showSettings]);

  // Auto-select first provider with a key
  useEffect(() => {
    if (!selectedProvider && providers && configuredKeys) {
      const configuredProviders = getConfiguredProviders();
      if (configuredProviders.length > 0) {
        setSelectedProvider(configuredProviders[0][0]);
      }
    }
  }, [providers, configuredKeys, selectedProvider]);

  // Fetch models when provider changes
  useEffect(() => {
    if (selectedProvider && !dynamicModels[selectedProvider]) {
      const fetchModels = async () => {
        setLoadingModels(true);
        try {
          const result = await settings.getProviderModels(selectedProvider);
          setDynamicModels(prev => ({
            ...prev,
            [selectedProvider]: result.models
          }));
          // Auto-select default model
          if (!selectedModel) {
            setSelectedModel(result.default_model);
          }
        } catch (err) {
          console.error('Failed to fetch models:', err);
          // Fallback to static models
          if (providers[selectedProvider]) {
            setDynamicModels(prev => ({
              ...prev,
              [selectedProvider]: providers[selectedProvider].models
            }));
            if (!selectedModel) {
              setSelectedModel(providers[selectedProvider].default_model);
            }
          }
        } finally {
          setLoadingModels(false);
        }
      };
      fetchModels();
    }
  }, [selectedProvider, dynamicModels, providers, selectedModel]);

  const loadApiKeys = async () => {
    try {
      const data = await settings.getApiKeys();
      setApiKeys(data.keys);
      setConfiguredKeys(data.configured);
      setIsEnvKey(data.is_env_key || {});
    } catch (err) {
      console.error('Failed to load API keys:', err);
    }
  };

  // Load words when deck changes
  useEffect(() => {
    if (!selectedDeck) {
      setWordsData(null);
      setAvailableFields([]);
      setFieldUsed(null);
      setSelectedWords([]);
      setLookupFields([]);
      return;
    }

    const loadWords = async () => {
      setLoadingWords(true);
      try {
        const data = await decks.getWords(selectedDeck, 500, selectedField);
        setWordsData(data);
        setAvailableFields(data.available_fields);
        setFieldUsed(data.field_used);

        // Auto-select lookup fields (exclude the word field itself)
        const defaultLookup = data.available_fields.filter(f => f !== data.field_used).slice(0, 2);
        setLookupFields(defaultLookup);

        // Auto-select words based on mode
        if (selectionMode === 'weighted') {
          const selected = selectWordsByWeight(data, weights, targetWordCount);
          setSelectedWords(selected);
        } else {
          setSelectedWords(data.words.slice(0, 20));
        }
      } catch (err) {
        console.error('Failed to load words:', err);
      } finally {
        setLoadingWords(false);
      }
    };
    loadWords();
  }, [selectedDeck, selectedField]);

  // Re-select words when weights or target count changes (in weighted mode)
  useEffect(() => {
    if (selectionMode === 'weighted' && wordsData) {
      const selected = selectWordsByWeight(wordsData, weights, targetWordCount);
      setSelectedWords(selected);
    }
  }, [weights, targetWordCount, selectionMode]);

  const selectWordsByWeight = (data: DeckWordsResponse, w: WeightSettings, count: number): string[] => {
    const categories = data.categories;
    const byCategory: Record<string, string[]> = { learning: [], relearning: [], young: [], mature: [], new: [] };

    for (const word of data.words) {
      const cat = categories[word] || 'unknown';
      if (cat in byCategory) {
        byCategory[cat].push(word);
      }
    }

    const totalWeight = w.learning + w.relearning + w.young + w.mature + w.new;
    if (totalWeight === 0) return [];

    const allocation: Record<string, number> = {};
    let remaining = count;
    const sortedCats = Object.keys(w).sort((a, b) => w[b as keyof WeightSettings] - w[a as keyof WeightSettings]);

    for (const cat of sortedCats) {
      const weight = w[cat as keyof WeightSettings];
      if (weight === 0) continue;
      const available = byCategory[cat]?.length || 0;
      const desired = Math.ceil((weight / totalWeight) * count);
      allocation[cat] = Math.min(desired, available, remaining);
      remaining -= allocation[cat];
    }

    if (remaining > 0) {
      for (const cat of sortedCats) {
        const weight = w[cat as keyof WeightSettings];
        if (weight === 0) continue;
        const available = byCategory[cat]?.length || 0;
        const alreadyTaken = allocation[cat] || 0;
        const canTake = Math.min(available - alreadyTaken, remaining);
        if (canTake > 0) {
          allocation[cat] = (allocation[cat] || 0) + canTake;
          remaining -= canTake;
        }
      }
    }

    const result: string[] = [];
    for (const cat of sortedCats) {
      const toTake = allocation[cat] || 0;
      if (toTake > 0) {
        const shuffled = [...(byCategory[cat] || [])].sort(() => Math.random() - 0.5);
        result.push(...shuffled.slice(0, toTake));
      }
    }
    return result;
  };

  const toggleWord = (word: string) => {
    setSelectedWords((prev) =>
      prev.includes(word) ? prev.filter((w) => w !== word) : [...prev, word]
    );
  };

  const toggleLookupField = (field: string) => {
    setLookupFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
  };

  const selectAll = () => setSelectedWords([...(wordsData?.words || [])]);
  const clearAll = () => setSelectedWords([]);
  const selectRandom = (count: number) => {
    const shuffled = [...(wordsData?.words || [])].sort(() => Math.random() - 0.5);
    setSelectedWords(shuffled.slice(0, count));
  };

  const getAllWords = (): string[] => {
    const allWords = [...selectedWords];
    if (customWords.trim()) {
      const custom = customWords.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
      allWords.push(...custom);
    }
    return [...new Set(allWords)];
  };

  const getWordData = (): Record<string, WordData> => {
    if (!wordsData?.word_data) return {};
    const result: Record<string, WordData> = {};
    for (const word of getAllWords()) {
      if (wordsData.word_data[word]) {
        result[word] = wordsData.word_data[word];
      }
    }
    return result;
  };

  const handleGenerate = async () => {
    const wordsToUse = getAllWords();
    if (wordsToUse.length === 0) {
      setError('Please select some words or add custom words');
      return;
    }

    setLoading(true);
    setError('');
    setGeneratedStoryId(null);
    setProviderUsed(null);
    setModelUsed(null);

    try {
      const result = await story.generate({
        words: wordsToUse,
        wordData: getWordData(),
        style,
        length,
        language: language === 'custom' ? customLanguage : language,
        targetLanguage: targetLanguage || undefined,
        customInstructions: style === 'custom' ? customInstructions : undefined,
        provider: selectedProvider || undefined,
        model: selectedModel || undefined,
        deckName: selectedDeck || undefined,
        name: storyName || undefined,
        lookupFields,
        lookupLanguage: lookupLanguage === 'custom' ? customLookupLanguage : lookupLanguage,
      });
      setGeneratedStory(result.story);
      setGeneratedStoryId(result.story_id);
      setProviderUsed(result.provider_used || null);
      setModelUsed(result.model_used || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate story');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveKey = async (provider: string) => {
    if (!newKeyValue.trim()) return;
    setSavingKey(true);
    try {
      await settings.setApiKey(provider, newKeyValue.trim());
      await loadApiKeys();
      const providerData = await settings.getProviders();
      setProviders(providerData.providers);
      setEditingKey(null);
      setNewKeyValue('');
    } catch (err) {
      console.error('Failed to save API key:', err);
    } finally {
      setSavingKey(false);
    }
  };

  const handleDeleteKey = async () => {
    if (!deleteConfirm) return;

    try {
      await settings.deleteApiKey(deleteConfirm.provider);
      await loadApiKeys();
      const providerData = await settings.getProviders();
      setProviders(providerData.providers);
      setDeleteConfirm(null);
    } catch (err) {
      console.error('Failed to delete API key:', err);
      setDeleteConfirm(null);
    }
  };

  const getConfiguredProviders = () =>
    Object.entries(providers).filter(([id]) => configuredKeys[id]);

  const getProviderStatus = (providerId: string) => {
    if (configuredKeys[providerId]) {
      return { text: 'Configured', className: 'bg-green-500/20 text-green-400' };
    }
    return { text: 'Not set', className: 'bg-(--bg-tertiary) text-(--text-secondary)' };
  };

  const categoryCounts = useMemo(() => wordsData?.category_counts || null, [wordsData]);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">{t('story.title')}</h2>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`btn ${showSettings ? 'btn-primary' : 'btn-secondary'} flex items-center gap-2`}
        >
          <Key className="w-4 h-4" />
          {t('story.apiKeys', 'API Keys')}
        </button>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div className="card border-2 border-(--accent)/30">
          <div className="flex items-center gap-2 mb-4">
            <Settings2 className="w-5 h-5 text-(--accent)" />
            <h3 className="font-semibold">AI Provider Settings</h3>
          </div>

          <div className="space-y-3">
            {Object.entries(providers).map(([providerId, info]) => {
              const status = getProviderStatus(providerId);
              return (
                <div key={providerId} className="flex items-center gap-3 p-3 bg-(--bg-secondary) rounded-lg">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{info.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${status.className}`}>
                        {status.text}
                      </span>
                    </div>
                    {editingKey === providerId ? (
                      <div className="mt-2 space-y-3">
                        {/* API Key Input */}
                        <div>
                          <label className="block text-xs text-(--text-secondary) mb-1">API Key (for making requests)</label>
                          <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                              <input
                                type={showKeyValue ? 'text' : 'password'}
                                value={newKeyValue}
                                onChange={(e) => setNewKeyValue(e.target.value)}
                                placeholder="Enter API key..."
                                className="input w-full pr-10"
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={() => setShowKeyValue(!showKeyValue)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-(--text-secondary) hover-text-primary"
                              >
                                {showKeyValue ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Save/Cancel Buttons */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleSaveKey(providerId)}
                            disabled={savingKey || !newKeyValue.trim()}
                            className="btn btn-primary flex-1"
                          >
                            {savingKey ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            onClick={() => {
                              setEditingKey(null);
                              setNewKeyValue('');
                            }}
                            className="btn btn-secondary flex-1"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-(--text-secondary) mt-1">
                        {(() => {
                          const key = apiKeys[providerId];

                          if (!key) return 'No API key configured';

                          return (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={async () => {
                                  try {
                                    const result = await settings.getFullApiKey(providerId);
                                    await navigator.clipboard.writeText(result.api_key);
                                    setCopiedProvider(providerId);
                                    setTimeout(() => setCopiedProvider(null), 2000);
                                  } catch (err) {
                                    console.error('Failed to copy key:', err);
                                  }
                                }}
                                className="hover:text-(--text-primary) cursor-pointer transition-colors flex items-center gap-2"
                                title="Click to copy full API key"
                              >
                                {key}
                                {copiedProvider === providerId && (
                                  <Check className="w-3 h-3 text-green-400" />
                                )}
                              </button>
                              {isEnvKey[providerId] && (
                                <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                                  from .env
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  {editingKey !== providerId && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          setEditingKey(providerId);
                          setNewKeyValue('');
                          setShowKeyValue(false);
                          // Load existing key when editing
                          if (configuredKeys[providerId]) {
                            try {
                              const result = await settings.getFullApiKey(providerId);
                              setNewKeyValue(result.api_key || '');
                            } catch (err) {
                              console.error('Failed to load key:', err);
                            }
                          }
                        }}
                        className="btn btn-secondary p-2"
                        title={configuredKeys[providerId] ? 'Edit' : 'Add'}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {configuredKeys[providerId] && !isEnvKey[providerId] && (
                        <button
                          onClick={() => setDeleteConfirm({ provider: providerId, providerName: info.name })}
                          className="btn btn-secondary p-2 text-(--error)"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

        </div>
      )}

      <p className="text-(--text-secondary)">
        {t('story.description', 'Generate stories using your vocabulary words to reinforce learning through context.')}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Word Selection */}
        <div className="space-y-4">
          <div className="card">
            <h3 className="font-semibold mb-3">1. Select Words</h3>

            <div className="mb-4">
              <label className="block text-sm text-(--text-secondary) mb-1">Load from deck</label>
              <select
                value={selectedDeck}
                onChange={(e) => { setSelectedDeck(e.target.value); setSelectedField(''); }}
                className="input w-full"
              >
                <option value="">Select a deck...</option>
                {deckList.map((deck) => (
                  <option key={deck.id} value={deck.name}>{deck.name}</option>
                ))}
              </select>
            </div>

            {availableFields.length > 1 && (
              <div className="mb-4">
                <label className="block text-sm text-(--text-secondary) mb-1">Word field</label>
                <select
                  value={selectedField}
                  onChange={(e) => setSelectedField(e.target.value)}
                  className="input w-full"
                >
                  <option value="">Auto ({fieldUsed || 'none'})</option>
                  {availableFields.map((field) => (
                    <option key={field} value={field}>{field}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Lookup fields selection */}
            {availableFields.length > 1 && (
              <div className="mb-4">
                <label className="block text-sm text-(--text-secondary) mb-1">Lookup fields (for Reading page)</label>
                <div className="flex flex-wrap gap-2">
                  {availableFields.filter(f => f !== fieldUsed).map((field) => (
                    <button
                      key={field}
                      onClick={() => toggleLookupField(field)}
                      className={`field-btn ${lookupFields.includes(field) ? 'active' : ''}`}
                    >
                      {field}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-(--text-secondary) mt-1">
                  Selected fields will be shown when you click words in Reading
                </p>
              </div>
            )}

            {/* Lookup language for AI lookups */}
            <div className="mb-4">
              <label className="block text-sm text-(--text-secondary) mb-1">Lookup language (AI translations)</label>
              <select
                value={lookupLanguage}
                onChange={(e) => setLookupLanguage(e.target.value)}
                className="input w-full"
              >
                <option value="auto">Auto-detect</option>
                <option value="English">English</option>
                <option value="Japanese">Japanese</option>
                <option value="Chinese">Chinese</option>
                <option value="Korean">Korean</option>
                <option value="Spanish">Spanish</option>
                <option value="French">French</option>
                <option value="German">German</option>
                <option value="Portuguese">Portuguese</option>
                <option value="Russian">Russian</option>
                <option value="custom">Custom...</option>
              </select>
              {lookupLanguage === 'custom' && (
                <input
                  type="text"
                  value={customLookupLanguage}
                  onChange={(e) => setCustomLookupLanguage(e.target.value)}
                  placeholder="Enter language (e.g., Italian)"
                  className="input w-full mt-2"
                />
              )}
              <p className="text-xs text-(--text-secondary) mt-1">
                Language for AI-powered lookups on non-vocabulary words
              </p>
            </div>

            {/* Category stats */}
            {categoryCounts && Object.keys(categoryCounts).length > 0 && (
              <div className="mb-4 p-3 bg-(--bg-secondary) rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Info className="w-4 h-4 text-(--text-secondary)" />
                  <span className="text-sm font-medium">Card Categories (total: {wordsData?.total || 0})</span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  {(['learning', 'relearning', 'young', 'mature', 'new'] as CardCategory[]).map((cat) => {
                    const count = categoryCounts[cat] || 0;
                    if (count === 0) return null;
                    return (
                      <span key={cat} title={CATEGORY_INFO[cat].description}>
                        {CATEGORY_INFO[cat].label}: {count}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Selection mode */}
            {wordsData && wordsData.words.length > 0 && (
              <div className="mb-4">
                <div className="flex gap-2 p-1 bg-(--bg-secondary) rounded-lg">
                  <button
                    onClick={() => setSelectionMode('weighted')}
                    className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                      selectionMode === 'weighted' ? 'bg-(--accent) text-white' : 'text-(--text-secondary)'
                    }`}
                  >
                    Smart Selection
                  </button>
                  <button
                    onClick={() => setSelectionMode('manual')}
                    className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                      selectionMode === 'manual' ? 'bg-(--accent) text-white' : 'text-(--text-secondary)'
                    }`}
                  >
                    Manual
                  </button>
                </div>
              </div>
            )}

            {/* Weighted controls */}
            {selectionMode === 'weighted' && wordsData && (
              <div className="mb-4 p-3 bg-(--bg-secondary) rounded-lg space-y-3">
                <div>
                  <label className="block text-sm text-(--text-secondary) mb-1">
                    Target: {targetWordCount} words
                  </label>
                  <input
                    type="range"
                    min="5"
                    max="50"
                    value={targetWordCount}
                    onChange={(e) => setTargetWordCount(Number(e.target.value))}
                    className="w-full accent-slider"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {(['learning', 'relearning', 'young', 'mature', 'new'] as const).map((cat) => (
                    <div key={cat} className="flex items-center gap-2">
                      <span className="flex-1">{CATEGORY_INFO[cat].label}</span>
                      <input
                        type="number"
                        min="0"
                        max="10"
                        value={weights[cat]}
                        onChange={(e) => setWeights(w => ({ ...w, [cat]: Number(e.target.value) }))}
                        className="input w-14 text-xs py-1 px-2 text-center"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Word cloud */}
            {loadingWords ? (
              <div className="text-center py-4 text-(--text-secondary)">Loading words...</div>
            ) : wordsData && wordsData.words.length > 0 ? (
              <>
                {selectionMode === 'manual' && (
                  <div className="flex gap-2 mb-2 flex-wrap">
                    <button onClick={selectAll} className="btn btn-secondary text-xs py-1">All</button>
                    <button onClick={clearAll} className="btn btn-secondary text-xs py-1">Clear</button>
                    <button onClick={() => selectRandom(10)} className="btn btn-secondary text-xs py-1">Random 10</button>
                    <button onClick={() => selectRandom(20)} className="btn btn-secondary text-xs py-1">Random 20</button>
                  </div>
                )}

                <div className="max-h-48 overflow-y-auto border border-(--bg-tertiary) rounded-lg p-2">
                  <div className="flex flex-wrap gap-1">
                    {wordsData.words.map((word, idx) => (
                      <button
                        key={`${word}-${idx}`}
                        onClick={() => toggleWord(word)}
                        className={`px-2 py-1 rounded text-sm transition-colors ${
                          selectedWords.includes(word)
                            ? 'bg-(--accent) text-white'
                            : 'bg-(--bg-tertiary) text-(--text-secondary) hover-bg-tertiary'
                        }`}
                      >
                        {word}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-xs text-(--text-secondary) mt-2">
                  {selectedWords.length} selected
                </p>
              </>
            ) : selectedDeck ? (
              <p className="text-(--text-secondary) text-sm">No words found.</p>
            ) : null}

            {/* Custom words */}
            <div className="mt-4">
              <label className="block text-sm text-(--text-secondary) mb-1">Custom words</label>
              <textarea
                value={customWords}
                onChange={(e) => setCustomWords(e.target.value)}
                placeholder="apple, banana, cherry..."
                className="input w-full h-16 resize-none"
              />
            </div>
          </div>
        </div>

        {/* Right: Options */}
        <div className="space-y-4">
          <div className="card">
            <h3 className="font-semibold mb-3">2. Configure Story</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-(--text-secondary) mb-1">AI Provider</label>
                <select
                  value={selectedProvider}
                  onChange={(e) => { setSelectedProvider(e.target.value); setSelectedModel(''); setDynamicModels({}); }}
                  className="input w-full"
                >
                  {getConfiguredProviders().map(([id, info]) => (
                    <option key={id} value={id}>{info.name}</option>
                  ))}
                </select>
              </div>

              {selectedProvider && (
                <div>
                  <label className="block text-sm text-(--text-secondary) mb-1">Model</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="input w-full"
                    disabled={loadingModels}
                  >
                    {loadingModels ? (
                      <option value="">Loading models...</option>
                    ) : (
                      (dynamicModels[selectedProvider] || providers[selectedProvider]?.models || []).map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))
                    )}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm text-(--text-secondary) mb-1">Style</label>
                <select value={style} onChange={(e) => setStyle(e.target.value)} className="input w-full">
                  {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>

              {style === 'custom' && (
                <div>
                  <label className="block text-sm text-(--text-secondary) mb-1">Custom Instructions</label>
                  <textarea
                    value={customInstructions}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                    placeholder="E.g., Write a mystery story..."
                    className="input w-full h-20 resize-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm text-(--text-secondary) mb-1">Length</label>
                <select value={length} onChange={(e) => setLength(e.target.value)} className="input w-full">
                  {LENGTHS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm text-(--text-secondary) mb-1">Language</label>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className="input w-full">
                  <option value="auto">Auto-detect</option>
                  <option value="English">English</option>
                  <option value="Japanese">Japanese</option>
                  <option value="Chinese">Chinese</option>
                  <option value="Korean">Korean</option>
                  <option value="Spanish">Spanish</option>
                  <option value="French">French</option>
                  <option value="German">German</option>
                  <option value="custom">Custom...</option>
                </select>
                {language === 'custom' && (
                  <input
                    type="text"
                    value={customLanguage}
                    onChange={(e) => setCustomLanguage(e.target.value)}
                    placeholder="Enter language (e.g., Italian)"
                    className="input w-full mt-2"
                  />
                )}
              </div>

              <div>
                <label className="block text-sm text-(--text-secondary) mb-1">Bilingual (optional)</label>
                <input
                  type="text"
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value)}
                  placeholder="e.g., Japanese"
                  className="input w-full"
                />
              </div>

              <div>
                <label className="block text-sm text-(--text-secondary) mb-1">Story Name (optional)</label>
                <input
                  type="text"
                  value={storyName}
                  onChange={(e) => setStoryName(e.target.value)}
                  placeholder="Auto-generated"
                  className="input w-full"
                />
              </div>
            </div>
          </div>

          <button
            onClick={handleGenerate}
            disabled={loading || getAllWords().length === 0 || getConfiguredProviders().length === 0}
            className="btn btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> {t('story.generating')}</>
            ) : (
              <><Wand2 className="w-5 h-5" /> {t('story.generate')} ({getAllWords().length} {t('story.words', 'words')})</>
            )}
          </button>

          {error && <div className="text-(--error) text-sm text-center">{error}</div>}
        </div>
      </div>

      {/* Generated Story */}
      {generatedStory && (
        <div className="card">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-(--accent)" />
              <h3 className="font-semibold">Your Story</h3>
              {providerUsed && modelUsed && (
                <span className="flex items-center gap-1 text-xs text-(--text-secondary) bg-(--bg-secondary) px-2 py-1 rounded">
                  <Cpu className="w-3 h-3" /> {providerUsed}/{modelUsed}
                </span>
              )}
            </div>
            {generatedStoryId && (
              <button onClick={() => navigate(`/reading?story=${generatedStoryId}`)} className="btn btn-secondary flex items-center gap-2 text-sm">
                <ExternalLink className="w-4 h-4" /> Open in Reading
              </button>
            )}
          </div>

          {generatedStoryId && (
            <div className="flex items-center gap-2 mb-4 p-2 bg-green-500/10 border border-green-500/30 rounded-lg text-sm">
              <Check className="w-4 h-4 text-green-400" />
              <span>Story saved!</span>
              <button onClick={() => navigate('/reading')} className="text-(--accent) underline">
                Reading Library
              </button>
            </div>
          )}

          <div className="prose max-w-none">
            <ReactMarkdown>{generatedStory}</ReactMarkdown>
          </div>
        </div>
      )}

      <style>{`
        .accent-slider {
          accent-color: var(--accent);
        }
        input[type="range"] {
          -webkit-appearance: none;
          height: 6px;
          background: var(--bg-tertiary);
          border-radius: 3px;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          background: var(--accent);
          border-radius: 50%;
          cursor: pointer;
        }
      `}</style>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="card max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-2">Delete API Key</h3>
            <p className="text-(--text-secondary) mb-4">
              Are you sure you want to delete the API key for{' '}
              <span className="text-white font-semibold">{deleteConfirm.providerName}</span>?
            </p>
            <p className="text-sm text-(--text-secondary) mb-4">
              This will remove the configured API key for this provider.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteConfirm(null)} className="btn btn-secondary">
                Cancel
              </button>
              <button onClick={handleDeleteKey} className="btn bg-red-500 hover:bg-red-600 text-white">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
