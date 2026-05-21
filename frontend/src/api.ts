const API_BASE = '/api';

async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(error.detail || 'Request failed');
  }

  return response.json();
}

// Setup
export const setup = {
  status: () => fetchAPI<{ needs_setup: boolean; has_admin: boolean; has_container: boolean }>('/setup/status'),
  createAdmin: (username: string, password: string) =>
    fetchAPI<{ success: boolean; username: string }>('/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  containerStreamUrl: (name: string) => `${API_BASE}/setup/container/stream?name=${encodeURIComponent(name)}`,
};

// Auth
export interface User {
  username: string;
  is_admin: boolean;
  can_add_containers: boolean;
  can_edit_server_accent: boolean;
  language: string;
  accent_color?: string | null;
  accent_hover?: string | null;
  has_personal_accent?: boolean;
  base_colors?: Record<string, string> | null;
  has_personal_base_colors?: boolean;
}

export const auth = {
  login: (username: string, password: string) =>
    fetchAPI<{ success: boolean; message: string; user?: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => fetchAPI('/auth/logout', { method: 'POST' }),
  check: () => fetchAPI<{ authenticated: boolean; user?: User }>('/auth/check'),
  me: () => fetchAPI<User>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    fetchAPI<{ success: boolean; message: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
  changeLanguage: (language: string) =>
    fetchAPI<{ success: boolean; message: string; language: string }>('/auth/change-language', {
      method: 'POST',
      body: JSON.stringify({ language }),
    }),
  setAccent: (accent: string, hover?: string) =>
    fetchAPI<{ success: boolean }>('/auth/accent', {
      method: 'PATCH',
      body: JSON.stringify({ accent, hover }),
    }),
  clearAccent: () => fetchAPI<{ success: boolean; accent: string; hover: string }>('/auth/accent', { method: 'DELETE' }),
  setBaseColors: (colors: Record<string, string>) =>
    fetchAPI<{ success: boolean }>('/auth/base-colors', {
      method: 'PATCH',
      body: JSON.stringify(colors),
    }),
  clearBaseColors: () => fetchAPI<Record<string, string>>('/auth/base-colors', { method: 'DELETE' }),
};

export const theme = {
  get: () => fetchAPI<{ accent: string; hover: string }>('/theme'),
  set: (accent: string, hover?: string) =>
    fetchAPI<{ success: boolean; accent: string; hover: string }>('/theme', {
      method: 'PATCH',
      body: JSON.stringify({ accent, hover }),
    }),
  getBase: () => fetchAPI<Record<string, string>>('/theme/base'),
  setBase: (colors: Record<string, string>) =>
    fetchAPI<Record<string, string>>('/theme/base', {
      method: 'PATCH',
      body: JSON.stringify(colors),
    }),
};

// Decks
export interface DeckStats {
  deck_id: number;
  name: string;
  new_count: number;
  learn_count: number;
  review_count: number;
  total_in_deck: number;
}

// Card categories from Anki
export type CardCategory = 'new' | 'learning' | 'young' | 'mature' | 'relearning' | 'suspended' | 'buried' | 'unknown';

export interface WordData {
  fields: Record<string, string>;
  category: CardCategory;
}

export interface DeckWordsResponse {
  words: string[];
  word_data: Record<string, WordData>;
  total: number;
  field_used: string | null;
  available_fields: string[];
  categories: Record<string, CardCategory>;
  category_counts: Record<CardCategory, number>;
}

export const decks = {
  list: () => fetchAPI<{ decks: Record<string, number>; stats: Record<string, DeckStats> }>('/decks'),
  getDueCards: (deckName: string) => fetchAPI<{ cards: Card[] }>(`/decks/${encodeURIComponent(deckName)}/due`),
  getNextCard: (deckName: string) => fetchAPI<{ card: Card | null; remaining: number }>(`/decks/${encodeURIComponent(deckName)}/next`),
  getWords: (deckName: string, limit = 200, field = '') =>
    fetchAPI<DeckWordsResponse>(
      `/decks/${encodeURIComponent(deckName)}/words?limit=${limit}${field ? `&field=${encodeURIComponent(field)}` : ''}`
    ),
  delete: (deckName: string) =>
    fetchAPI<{ success: boolean; message: string }>('/decks/delete', {
      method: 'POST',
      body: JSON.stringify({ deck_name: deckName }),
    }),
  rename: (oldName: string, newName: string) =>
    fetchAPI<{ success: boolean; message: string }>('/decks/rename', {
      method: 'POST',
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    }),
};

// Cards
export interface Card {
  cardId: number;
  fields: Record<string, { value: string; order: number }>;
  fieldOrder: number;
  question: string;
  answer: string;
  modelName: string;
  ord: number;
  deckName: string;
  css: string;
  factor: number;
  interval: number;
  note: number;
  type: number;
  queue: number;
  due: number;
  reps: number;
  lapses: number;
  left: number;
}

export const cards = {
  answer: (cardId: number, ease: 1 | 2 | 3 | 4) =>
    fetchAPI<{ success: boolean }>('/cards/answer', {
      method: 'POST',
      body: JSON.stringify({ card_id: cardId, ease }),
    }),
  get: (cardId: number) => fetchAPI<Card>(`/cards/${cardId}`),
  undo: () => fetchAPI<{ success: boolean }>('/cards/undo', { method: 'POST' }),
};

// Media
export const media = {
  get: (filename: string) =>
    fetchAPI<{ filename: string; data: string }>(`/media/${encodeURIComponent(filename)}`),
};

// Search
export interface Note {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
}

export const search = {
  notes: (query: string, limit = 50) =>
    fetchAPI<{ notes: Note[]; total: number }>('/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
};

// Story generation result
export interface StoryGenerateResult {
  story: string;
  story_id: number;
  provider_used?: string;
  model_used?: string;
}

// Story generation options
export interface StoryGenerateOptions {
  words: string[];
  wordData?: Record<string, WordData>;
  style?: string;
  length?: string;
  language?: string;
  targetLanguage?: string;
  customInstructions?: string;
  provider?: string;
  model?: string;
  deckName?: string;
  name?: string;
  lookupFields?: string[];
  lookupLanguage?: string;
}

// Lookup result
export interface LookupResult {
  word: string;
  meaning: string;
  reading?: string;
  part_of_speech?: string;
  provider_used?: string;
  furigana?: string;
  example?: string;
  notes?: string;
  [key: string]: any;  // Allow additional fields from AI lookup
}

// Story
export const story = {
  generate: (options: StoryGenerateOptions) =>
    fetchAPI<StoryGenerateResult>('/story/generate', {
      method: 'POST',
      body: JSON.stringify({
        words: options.words,
        word_data: options.wordData,
        style: options.style || 'casual',
        length: options.length || 'medium',
        language: options.language || 'auto',
        target_language: options.targetLanguage,
        custom_instructions: options.customInstructions,
        provider: options.provider,
        model: options.model,
        deck_name: options.deckName,
        name: options.name,
        lookup_fields: options.lookupFields,
        lookup_language: options.lookupLanguage || 'auto',
      }),
    }),
};

// AI-powered word lookup
export const lookup = {
  word: (word: string, language = 'auto', provider?: string, model?: string, lookupFields?: string[], forceAI = false) =>
    fetchAPI<LookupResult>('/lookup', {
      method: 'POST',
      body: JSON.stringify({
        word,
        language,
        provider,
        model,
        lookup_fields: lookupFields,
        force_ai: forceAI,
      }),
    }),
  jisho: (word: string) =>
    fetchAPI<{ data: any[] }>(`/jisho/${encodeURIComponent(word)}`),
};

// Saved stories
export interface SavedStory {
  id: number;
  name: string;
  content?: string;
  words?: string[];
  word_data?: Record<string, WordData>;
  lookup_fields?: string[];
  lookup_language?: string;
  style?: string;
  length?: string;
  language?: string;
  target_language?: string;
  provider?: string;
  model?: string;
  deck_name?: string;
  created_at: string;
  content_length?: number;
}

export const stories = {
  list: (limit = 100, offset = 0) =>
    fetchAPI<{ stories: SavedStory[] }>(`/stories?limit=${limit}&offset=${offset}`),
  get: (id: number) => fetchAPI<{ story: SavedStory }>(`/stories/${id}`),
  update: (id: number, updates: { name?: string; lookup_fields?: string[] }) =>
    fetchAPI<{ success: boolean }>(`/stories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),
  delete: (id: number) =>
    fetchAPI<{ success: boolean }>(`/stories/${id}`, { method: 'DELETE' }),
};

// Update
export const update = {
  check: () => fetchAPI<{ current: string; latest: string; has_update: boolean }>('/update/check'),
  applyUrl: () => `${API_BASE}/update/apply`,
};

// Sync
export const sync = {
  trigger: () => fetchAPI<{ success: boolean; message: string }>('/sync', { method: 'POST' }),
  fullUpload: () => fetchAPI<{ success: boolean; message: string }>('/sync/full-upload', { method: 'POST' }),
  fullDownload: () => fetchAPI<{ success: boolean; message: string }>('/sync/full-download', { method: 'POST' }),
};

// AnkiWeb login
export interface AnkiWebStatus {
  has_credentials: boolean;
  configured: boolean;
  email?: string;
}

export const ankiweb = {
  login: (email: string, password: string) =>
    fetchAPI<{ success: boolean; message: string }>('/ankiweb/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  status: () => fetchAPI<AnkiWebStatus>('/ankiweb/status'),
  deleteCredentials: () =>
    fetchAPI<{ success: boolean }>('/ankiweb/credentials', { method: 'DELETE' }),
};

// Account Management
export interface AnkiAccount {
  id: number;
  email: string;
  container_name: string;
  container_port: number;
  volume_name: string;
  is_active: number;
  created_at: string;
  container_running?: boolean;
  ankiweb_email?: string | null;
  has_ankiweb?: boolean;
}

export interface AccountsResponse {
  accounts: AnkiAccount[];
  active_account_id: number | null;
}

export const accounts = {
  list: () => fetchAPI<AccountsResponse>('/accounts'),
  create: (containerName: string) =>
    fetchAPI<{ success: boolean; account: AnkiAccount; message: string }>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ container_name: containerName }),
    }),
  switch: (accountId: number) =>
    fetchAPI<{ success: boolean; message: string }>('/accounts/switch', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId }),
    }),
  delete: (accountId: number, removeData = false) =>
    fetchAPI<{ success: boolean; message: string }>(`/accounts/${accountId}?remove_data=${removeData}`, {
      method: 'DELETE',
    }),
  restart: (accountId: number) =>
    fetchAPI<{ success: boolean; message: string }>(`/accounts/${accountId}/restart`, {
      method: 'POST',
    }),
};

// Models
export const models = {
  list: () => fetchAPI<{ models: string[] }>('/models'),
};

// Import
export const importDeck = {
  upload: async (
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<{ success: boolean; message: string }> => {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();

      // Track upload progress
      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const progress = Math.round((e.loaded / e.total) * 100);
            onProgress(progress);
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status === 401) {
          window.location.href = '/login';
          reject(new Error('Unauthorized'));
          return;
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            resolve(response);
          } catch (err) {
            reject(new Error('Invalid response'));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.detail || 'Import failed'));
          } catch (err) {
            reject(new Error('Import failed'));
          }
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Network error'));
      });

      xhr.open('POST', `${API_BASE}/import`);
      xhr.withCredentials = true;
      xhr.send(formData);
    });
  },
};

// Stats
export interface ReviewHistory {
  daily_counts: Record<string, number>;
  daily_time: Record<string, number>;
  hourly_counts: Record<string, number>;
  button_counts: Record<string, number>;
  interval_ranges: Record<string, number>;
  today: number;
  today_time_seconds: number;
}

export const stats = {
  getReviewHistory: (deck?: string, source?: string) => {
    const params = new URLSearchParams();
    if (deck) params.set('deck', deck);
    if (source) params.set('source', source);
    const qs = params.toString();
    return fetchAPI<ReviewHistory>(`/stats/reviews${qs ? `?${qs}` : ''}`);
  },
  getHtml: () => fetchAPI<{ html: string }>('/stats/html'),
};

// Settings - API Keys
export interface ProviderModel {
  id: string;
  name: string;
}

export interface ProviderInfo {
  name: string;
  models: ProviderModel[];
  default_model: string;
  configured: boolean;
}

export const settings = {
  getApiKeys: () =>
    fetchAPI<{
      keys: Record<string, string>;
      admin_keys: Record<string, string>;
      configured: Record<string, boolean>;
      has_admin_key: Record<string, boolean>;
      is_env_key: Record<string, boolean>;
    }>('/settings/api-keys'),
  setApiKey: (provider: string, apiKey: string = "", adminKey: string = "") =>
    fetchAPI<{ success: boolean; message: string }>('/settings/api-keys', {
      method: 'POST',
      body: JSON.stringify({ provider, api_key: apiKey, admin_key: adminKey }),
    }),
  deleteApiKey: (provider: string) =>
    fetchAPI<{ success: boolean; message: string }>(`/settings/api-keys/${provider}`, {
      method: 'DELETE',
    }),
  getFullApiKey: (provider: string) =>
    fetchAPI<{ api_key: string; admin_key: string }>(`/settings/api-keys/${provider}/full`),
  getProviderModels: (provider: string) =>
    fetchAPI<{ models: ProviderModel[]; default_model: string }>(`/settings/api-keys/${provider}/models`),
  getProviders: () => fetchAPI<{ providers: Record<string, ProviderInfo> }>('/settings/providers'),
  getUsage: (provider: string) =>
    fetchAPI<{
      provider: string;
      has_usage: boolean;
      usage_type?: string;
      tokens_used_today?: number;
      message: string;
    }>(`/settings/api-keys/${provider}/usage`),
};

// Users (admin only)
export interface UserInfo {
  id: number;
  username: string;
  is_admin: boolean;
  can_add_containers: boolean;
  can_edit_server_accent: boolean;
  created_at: string;
}

export const users = {
  list: () =>
    fetchAPI<{ users: UserInfo[] }>('/users'),
  create: (username: string, password: string, is_admin: boolean, can_add_containers: boolean, can_edit_server_accent: boolean = false) =>
    fetchAPI<{ success: boolean; user_id: number; message: string }>('/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, is_admin, can_add_containers, can_edit_server_accent }),
    }),
  update: (userId: number, username?: string, password?: string, is_admin?: boolean, can_add_containers?: boolean, can_edit_server_accent?: boolean) =>
    fetchAPI<{ success: boolean; message: string }>(`/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ username, password, is_admin, can_add_containers, can_edit_server_accent }),
    }),
  delete: (userId: number) =>
    fetchAPI<{ success: boolean; message: string }>(`/users/${userId}`, { method: 'DELETE' }),
  getContainers: (userId: number) =>
    fetchAPI<{ container_ids: number[] }>(`/users/${userId}/containers`),
  setContainers: (userId: number, containerIds: number[]) =>
    fetchAPI<{ success: boolean; message: string }>(`/users/${userId}/containers`, {
      method: 'PUT',
      body: JSON.stringify({ container_ids: containerIds }),
    }),
};

export interface QuizletDeck {
  id: number;
  title: string;
  url: string;
  card_count: number;
  created_at: string;
  favorites_count?: number;
}

export interface QuizletCard {
  id: number;
  front: string;
  back: string;
  image?: string | null;
  position: number;
}

export const quizlet = {
  scrape: (url: string) =>
    fetchAPI<{ title: string; cards: { front: string; back: string; image?: string | null }[] }>('/quizlet/scrape', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  saveDecks: (title: string, url: string, cards: { front: string; back: string; image?: string | null }[]) =>
    fetchAPI<{ success: boolean; deck_id: number }>('/quizlet/decks', {
      method: 'POST',
      body: JSON.stringify({ title, url, cards }),
    }),
  listDecks: () =>
    fetchAPI<{ decks: QuizletDeck[] }>('/quizlet/decks'),
  getDeck: (id: number) =>
    fetchAPI<QuizletDeck & { cards: QuizletCard[] }>(`/quizlet/decks/${id}`),
  deleteDeck: (id: number) =>
    fetchAPI<{ success: boolean }>(`/quizlet/decks/${id}`, { method: 'DELETE' }),
  renameDeck: (id: number, title: string) =>
    fetchAPI<{ success: boolean }>(`/quizlet/decks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deckStats: (id: number) =>
    fetchAPI<{ studied_today: number }>(`/quizlet/decks/${id}/stats`),
  review: (deckId: number, cardId: number, ease: number) =>
    fetchAPI<{ success: boolean }>(`/quizlet/decks/${deckId}/review`, {
      method: 'POST',
      body: JSON.stringify({ card_id: cardId, ease }),
    }),
  getFavorites: (deckId: number) =>
    fetchAPI<{ card_ids: number[] }>(`/quizlet/decks/${deckId}/favorites`),
  toggleFavorite: (deckId: number, cardId: number) =>
    fetchAPI<{ favorited: boolean }>(`/quizlet/decks/${deckId}/favorites/${cardId}`, { method: 'POST' }),
};
