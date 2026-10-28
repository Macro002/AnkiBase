const API_BASE = '/api';

/** An error answer from the server, with the login lockout details when there are any. */
export class ApiError extends Error {
  waitSeconds?: number;
  remaining?: number;
  constructor(message: string, detail?: { wait_seconds?: number; remaining?: number }) {
    super(message);
    this.waitSeconds = detail?.wait_seconds;
    this.remaining = detail?.remaining;
  }
}

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
    if (!endpoint.includes('/auth/login')) {
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    const body = await response.json().catch(() => ({}));
    const detail = body.detail || {};
    throw new ApiError(typeof detail === 'object' ? (detail.message || 'Invalid credentials') : String(detail),
                       typeof detail === 'object' ? detail : undefined);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    const detail = error.detail;
    if (typeof detail === 'object' && detail !== null) {
      throw new ApiError(detail.message || 'Request failed', detail);
    }
    throw new Error(detail || 'Request failed');
  }

  return response.json();
}

// Setup
export const setup = {
  status: () => fetchAPI<{ needs_setup: boolean; has_admin: boolean; has_container: boolean }>('/setup/status'),
  createAdmin: (username: string, password: string, language?: string) =>
    fetchAPI<{ success: boolean; username: string }>('/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username, password, language }),
    }),
  /** Waits for Anki (installed on the very first start) and creates the profile, reporting
   *  progress events. */
  createProfile: (name: string, onEvent: (event: unknown) => void) =>
    streamEvents(`${API_BASE}/setup/profile`, onEvent, undefined, { method: 'POST', body: JSON.stringify({ name }) }),
};

// Auth
export type Permission = 'manage_profiles' | 'server_theme' | 'use_ai' | 'manage_ai_keys' | 'import';

export interface User {
  username: string;
  is_admin: boolean;
  can_add_containers: boolean;
  can_edit_server_accent: boolean;
  /** What this user may do (admins: everything). */
  permissions?: Record<Permission, boolean>;
  /** The profile (Anki collection) this login is using. */
  profile?: { id: number; name: string } | null;
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
  names: () => fetchAPI<{ decks: Record<string, number> }>('/decks/names'),
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

// Media
export const media = {
  get: (filename: string) =>
    fetchAPI<{ filename: string; data: string }>(`/media/${encodeURIComponent(filename)}`),
};

// Studying through Anki's reviewer
export interface ReviewCard {
  card_id: number; question: string; answer: string; css: string; model: string | null; deck: string | null;
  buttons: number[]; next_reviews: string[]; fields: { name: string; value: string }[];
}
export interface ReviewState {
  card: ReviewCard | null; counts: { new: number; learn: number; review: number };
  mode: 'reviewer' | 'legacy'; media_token: string;
}
export const review = {
  current: (deck: string) => fetchAPI<ReviewState>('/review/current', { method: 'POST', body: JSON.stringify({ deck }) }),
  answer: (deck: string, cardId: number, ease: number) =>
    fetchAPI<ReviewState>('/review/answer', { method: 'POST', body: JSON.stringify({ deck, card_id: cardId, ease }) }),
  undo: (deck: string) => fetchAPI<ReviewState>('/review/undo', { method: 'POST', body: JSON.stringify({ deck }) }),
};

// Search
export interface Note {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
}

// Dictionary + "in your cards" search (Search tab)
export interface DictSegment { t: string; w?: string }
export interface DictSense { segments: DictSegment[]; examples: { text: string; translation: string | null }[] }
export interface DictEntry {
  pos: string; headword: string | null; gender: string | null;
  forms: { label: string; form: string }[]; senses: DictSense[];
  related: Partial<Record<'synonyms' | 'antonyms' | 'derived' | 'related', string[]>>;
}
export interface DictLanguage { language: string; ipa: string[]; audio: string[]; etymology: string | null; entries: DictEntry[] }
export interface JishoEntry {
  word: string; reading: string; other_forms: string[]; common: boolean; jlpt: string[];
  senses: { pos: string[]; glosses: string[]; info: string[] }[];
}
export interface DictionaryResult {
  wiktionary: { query: string; word: string; corrected: boolean; languages: DictLanguage[]; variants: string[]; source_url: string } | null;
  jisho: JishoEntry[];
  error: string | null;
}
export interface AnkiHit {
  note_id: number; model: string; tags: string[]; fields: { name: string; value: string }[];
  deck: string | null; deck_id: number | null; state: 'new' | 'learning' | 'young' | 'mature' | 'suspended' | null;
}
export interface QuizletHit { id: number; deck_id: number; front: string; back: string; image: string | null; title: string; level: number }
export interface CardSearchResult { anki: AnkiHit[]; quizlet: QuizletHit[]; anki_total: number; anki_error: string | null }

export const dictionary = {
  lookup: (q: string, lang: string) =>
    fetchAPI<DictionaryResult>(`/dictionary?${new URLSearchParams({ q, lang })}`),
  searchCards: (q: string) =>
    fetchAPI<CardSearchResult>(`/search/cards?${new URLSearchParams({ q })}`),
  updateNote: (noteId: number, fields: Record<string, string>) =>
    fetchAPI<{ success: boolean }>(`/notes/${noteId}/fields`, { method: 'PUT', body: JSON.stringify({ fields }) }),
  addAnki: (deck: string, front: string, back: string) =>
    fetchAPI<{ success: boolean; note_id: number }>(`/notes/basic?${new URLSearchParams({ deck })}`, { method: 'POST', body: JSON.stringify({ front, back }) }),
  addQuizlet: (deckId: number, front: string, back: string) =>
    fetchAPI<{ success: boolean; card_id: number }>(`/quizlet/decks/${deckId}/cards`, { method: 'POST', body: JSON.stringify({ front, back }) }),
};

// Story generation result
export interface StoryGenerateResult {
  story: string;
  story_id: number;
  title?: string;
  word_forms?: Record<string, string[]>;
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
  level?: string;
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
        level: options.level,
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
  level?: string | null;
  word_forms?: Record<string, string[]>;
  preview?: string;
  word_count?: number;
  annotations?: StoryAnnotations | null;
}

/** One reading unit of a story: a word or a fixed expression, explained in context. */
export interface StoryUnit { t: string; l?: string; p?: string; g?: string; n?: string; v?: string }
export interface StoryAnnotations { language: string | null; paragraphs: StoryUnit[][]; gloss_language?: string }

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
  annotate: (id: number, provider?: string, model?: string) =>
    fetchAPI<{ annotations: StoryAnnotations }>(`/stories/${id}/annotate`, { method: 'POST', body: JSON.stringify({ provider, model }) }),
  explain: (p: { passage: string; context: string; language?: string | null; gloss_language?: string; level?: string | null; provider?: string; model?: string }) =>
    fetchAPI<{ explanation: string }>('/story/explain', { method: 'POST', body: JSON.stringify(p) }),
};

/** Read a server-sent event stream with fetch (EventSource doesn't work in the iPhone
 *  app's web view). Calls `onEvent` with each event's parsed data; resolves when the
 *  stream ends, rejects if it can't be opened or breaks. */
export async function streamEvents(url: string, onEvent: (data: unknown) => void, signal?: AbortSignal,
                                   init: { method?: string; body?: string } = {}): Promise<void> {
  const response = await fetch(url, {
    method: init.method ?? 'GET', body: init.body, credentials: 'include', signal,
    headers: { Accept: 'text/event-stream', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) { try { onEvent(JSON.parse(data)); } catch { onEvent(data); } }
    }
  }
}

// Update
export const update = {
  check: () => fetchAPI<{ current: string; latest: string; has_update: boolean; channel?: string }>('/update/check'),
  /** Streams progress events; POST so another site can't start an update. */
  apply: (onEvent: (event: unknown) => void, signal?: AbortSignal) =>
    streamEvents(`${API_BASE}/update/apply`, onEvent, signal, { method: 'POST' }),
};

// Sync
export interface MediaSyncStatus { active: boolean; error: string | null }

export const sync = {
  trigger: () => fetchAPI<{ success: boolean; message: string; outcome?: string }>('/sync', { method: 'POST' }),
  /** The app only: media syncs in the background after a sync. */
  media: () => fetchAPI<MediaSyncStatus>('/sync/media'),
  fullUpload: () => fetchAPI<{ success: boolean; message: string }>('/sync/full-upload', { method: 'POST' }),
  fullDownload: () => fetchAPI<{ success: boolean; message: string }>('/sync/full-download', { method: 'POST' }),
};

// AnkiWeb login
export interface AnkiWebStatus {
  has_credentials: boolean;
  configured: boolean;
  email?: string | null;
  /** Unix seconds (the app) or what the server's engine reports. */
  last_sync?: number | string | null;
  /** A self-hosted sync server; null means AnkiWeb. */
  endpoint?: string | null;
}

export const ankiweb = {
  /** `endpoint`: a self-hosted sync server instead of AnkiWeb. */
  login: (email: string, password: string, endpoint?: string | null) =>
    fetchAPI<{ success: boolean; message: string }>('/ankiweb/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, endpoint: endpoint || null }),
    }),
  status: () => fetchAPI<AnkiWebStatus>('/ankiweb/status'),
  deleteCredentials: () =>
    fetchAPI<{ success: boolean }>('/ankiweb/credentials', { method: 'DELETE' }),
};

// This AnkiBase's own sync server (Anki's), for Anki on every device
export interface SyncServerStatus {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  /** The address to enter in Anki (Preferences → Syncing → self-hosted server). */
  url: string;
  /** Admins only. */
  accounts?: { name: string; created?: number; size: number }[];
}

export const syncServer = {
  status: () => fetchAPI<SyncServerStatus>('/syncserver'),
  start: () => fetchAPI<SyncServerStatus>('/syncserver/start', { method: 'POST' }),
  stop: () => fetchAPI<SyncServerStatus>('/syncserver/stop', { method: 'POST' }),
  addAccount: (name: string, password: string) =>
    fetchAPI<SyncServerStatus>('/syncserver/accounts', { method: 'POST', body: JSON.stringify({ name, password }) }),
  removeAccount: (name: string, deleteData: boolean) =>
    fetchAPI<SyncServerStatus>(`/syncserver/accounts/${encodeURIComponent(name)}?delete_data=${deleteData}`, { method: 'DELETE' }),
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
  rename: (accountId: number, name: string) =>
    fetchAPI<{ success: boolean; account: AnkiAccount }>(`/accounts/${accountId}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
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
          } catch {
            reject(new Error('Invalid response'));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.detail || 'Import failed'));
          } catch {
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
  fromAnkiWeb: (url: string) =>
    fetchAPI<{ success: boolean; message: string; deck_title: string }>('/import/ankiweb-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
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

export type StatsPeriod = '1m' | '3m' | '1y' | 'all';

export interface HourBucket { total: number; correct: number }
export interface RetentionCell { young_pass: number; young_fail: number; mature_pass: number; mature_fail: number }

export interface AnkiStats {
  today: {
    reviews: number; seconds: number; again: number;
    learn: number; review: number; relearn: number; filtered: number;
    mature_correct: number; mature_total: number;
  };
  calendar: Record<string, number>;
  /** day -> category counts (learn/young/mature/relearn/filtered) and seconds (`<cat>_s`) */
  daily: Record<string, Record<string, number>>;
  hourly: HourBucket[];
  buttons: { learning: number[]; young: number[]; mature: number[] };
  retention: Record<'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all', RetentionCell>;
  card_counts: { new: number; learning: number; relearning: number; young: number; mature: number; suspended: number; buried: number; total: number };
  intervals: Record<string, number>;
  ease: Record<string, number>;
  ease_avg: number | null;
  future_due: { days: Record<string, number>; overdue: number; learning_today: number; daily_load: number; known: boolean };
  added: Record<string, number>;
}

export interface QuizletStats {
  today: { answers: number; correct: number };
  calendar: Record<string, number>;
  daily: Record<string, number>;
  hourly: HourBucket[];
  accuracy: { total: number; correct: number };
  mastery: { not_studied: number; learning: number; familiar: number; mastered: number; total: number };
  hardest: { id: number; front: string; back: string; attempts: number; misses: number }[];
}

export interface StatsOverview {
  today: string;
  period: StatsPeriod;
  rollover_hours: number;
  anki: AnkiStats | null;
  anki_error: string | null;
  quizlet: QuizletStats | null;
}

export const stats = {
  overview: (p: { deck?: string; anki?: boolean; quizlet?: string; period: StatsPeriod; refresh?: boolean }) => {
    const q = new URLSearchParams({
      deck: p.deck ?? '',
      anki: String(p.anki ?? true),
      quizlet: p.quizlet ?? 'all',
      period: p.period,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      refresh: String(!!p.refresh),
    });
    return fetchAPI<StatsOverview>(`/stats/overview?${q}`);
  },
  getReviewHistory: (deck?: string, source?: string) => {
    const params = new URLSearchParams();
    if (deck) params.set('deck', deck);
    if (source) params.set('source', source);
    const qs = params.toString();
    return fetchAPI<ReviewHistory>(`/stats/reviews${qs ? `?${qs}` : ''}`);
  },
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
export interface UserFlags {
  is_admin: boolean;
  can_add_containers: boolean;      // manage profiles
  can_edit_server_accent: boolean;  // server theme
  can_use_ai: boolean;
  can_manage_ai_keys: boolean;
  can_import: boolean;
}

export interface UserInfo extends UserFlags {
  id: number;
  username: string;
  created_at: string;
  /** The first admin: only they can change their own account. */
  is_owner: boolean;
  /** Profiles this user may use (admins: all). */
  container_ids: number[];
}

export const users = {
  list: () => fetchAPI<{ users: UserInfo[]; profiles: AnkiAccount[] }>('/users'),
  create: (user: Partial<UserFlags> & { username: string; password: string; container_ids: number[] }) =>
    fetchAPI<{ success: boolean; user_id: number; message: string }>('/users', { method: 'POST', body: JSON.stringify(user) }),
  update: (userId: number, changes: Partial<UserFlags> & { username?: string; password?: string }) =>
    fetchAPI<{ success: boolean; message: string }>(`/users/${userId}`, { method: 'PUT', body: JSON.stringify(changes) }),
  delete: (userId: number) =>
    fetchAPI<{ success: boolean; message: string }>(`/users/${userId}`, { method: 'DELETE' }),
  setProfiles: (userId: number, containerIds: number[]) =>
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

export type QuizletStateMode = 'match' | 'blast' | 'blocks';

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
  updateCard: (deckId: number, cardId: number, front: string, back: string, image: string | null) =>
    fetchAPI<{ success: boolean }>(`/quizlet/decks/${deckId}/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ front, back, image }),
    }),
  getState: <T,>(deckId: number, mode: QuizletStateMode) =>
    fetchAPI<{ state: T | null }>(`/quizlet/decks/${deckId}/state/${mode}`),
  /** `keepalive` lets the save finish while the page is unloading. */
  putState: (deckId: number, mode: QuizletStateMode, state: unknown, keepalive = false) =>
    fetchAPI<{ success: boolean }>(`/quizlet/decks/${deckId}/state/${mode}`, {
      method: 'PUT',
      body: JSON.stringify({ state }),
      keepalive,
    }),
  deleteState: (deckId: number, mode: QuizletStateMode) =>
    fetchAPI<{ success: boolean }>(`/quizlet/decks/${deckId}/state/${mode}`, { method: 'DELETE' }),
  getWords: (deckId: number, side: 'term' | 'definition' = 'term') =>
    fetchAPI<DeckWordsResponse & { title: string; starred: string[]; missed: Record<string, number> }>(`/quizlet/decks/${deckId}/words?side=${side}`),
  fetchImage: (url: string) =>
    fetchAPI<{ data: string }>('/quizlet/fetch-image', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
};

// --- Study sessions (resumable activities listed in the Study hub) ---

export type SessionKind = 'quizlet-learn' | 'quizlet-flashcards' | 'quizlet-test' | 'anki' | 'reading';

export interface StudySession {
  kind: SessionKind;
  ref_id: string;
  title: string;
  detail: string | null;
  progress_done: number;
  progress_total: number;
  status: 'active' | 'completed';
  created_at: string;
  updated_at: string;
}

export interface SessionUpdate {
  title: string;
  detail?: string | null;
  progress_done?: number;
  progress_total?: number;
  status?: 'active' | 'completed';
  /** Omit to keep the previously saved state. */
  state?: unknown;
}

export const studySessions = {
  list: () => fetchAPI<{ sessions: StudySession[] }>('/sessions'),
  get: <T,>(kind: SessionKind, ref: string | number) =>
    fetchAPI<{ session: (StudySession & { state: T | null }) | null }>(`/sessions/${kind}/${encodeURIComponent(String(ref))}`),
  /** `keepalive` lets the save finish while the page is unloading. */
  put: (kind: SessionKind, ref: string | number, update: SessionUpdate, keepalive = false) =>
    fetchAPI<{ success: boolean }>(`/sessions/${kind}/${encodeURIComponent(String(ref))}`, {
      method: 'PUT',
      body: JSON.stringify(update),
      keepalive,
    }),
  remove: (kind: SessionKind, ref: string | number) =>
    fetchAPI<{ success: boolean }>(`/sessions/${kind}/${encodeURIComponent(String(ref))}`, { method: 'DELETE' }),
};
