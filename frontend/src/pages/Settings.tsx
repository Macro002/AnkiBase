import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Globe, Palette, RotateCcw, X, Download, Upload, Trash2, Sparkles, Users, User as UserIcon, Check, ChevronRight } from 'lucide-react';
import { Segmented } from '../components/quizlet/ui';
import { AiPanel, type AiChoice } from '../components/story/AiPanel';
import { useSpring } from '../hooks/useSpring';
import { auth, theme as themeApi, settings as settingsApi, type User, type ProviderInfo } from '../api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { UserManagement } from '../components/UserManagement';
import { Logo } from '../components/Logo';
import { useTranslation } from 'react-i18next';
import {
  ACCENT_PRESETS, saveAccentColor, applyBaseColors,
  BASE_COLORS_DEFAULT, saveBaseColors, type BaseColors,
} from '../hooks/useAccentColor';

type ThemeMode = 'personal' | 'server';

interface BaseColorField {
  key: keyof BaseColors;
  label: string;
}

interface ThemeEntry {
  name: string;
  accent: string;
  hover: string;
  base: BaseColors;
}

interface ThemeFile {
  name: string;
  version: number;
  accent: string;
  hover: string;
  base: BaseColors;
}

const CUSTOM_THEMES_KEY = 'ankibase-custom-themes';

function loadCustomThemes(): ThemeEntry[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCustomThemes(themes: ThemeEntry[]) {
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
}

const BG_FIELDS: BaseColorField[] = [
  { key: 'bg_primary',   label: 'Background' },
  { key: 'bg_secondary', label: 'Card / Panel' },
  { key: 'bg_tertiary',  label: 'Input / Border' },
];

const TEXT_FIELDS: BaseColorField[] = [
  { key: 'text_primary',   label: 'Primary text' },
  { key: 'text_secondary', label: 'Secondary text' },
];

const BUILTIN_THEMES: ThemeEntry[] = [
  {
    name: 'AnkiBase',
    accent: '#e94560',
    hover: '#ff6b6b',
    base: BASE_COLORS_DEFAULT,
  },
  {
    name: 'Midnight',
    accent: '#a855f7',
    hover: '#c084fc',
    base: {
      bg_primary:     '#0d0d0d',
      bg_secondary:   '#141414',
      bg_tertiary:    '#1f1f1f',
      text_primary:   '#f2f2f2',
      text_secondary: '#888888',
    } as BaseColors,
  },
  {
    name: 'Chalk',
    accent: '#06b6d4',
    hover: '#22d3ee',
    base: {
      bg_primary:     '#f0f2f5',
      bg_secondary:   '#ffffff',
      bg_tertiary:    '#d1d9e6',
      text_primary:   '#1e2330',
      text_secondary: '#64748b',
    } as BaseColors,
  },
  {
    name: 'Nord',
    accent: '#88c0d0',
    hover: '#81a1c1',
    base: {
      bg_primary:     '#2e3440',
      bg_secondary:   '#3b4252',
      bg_tertiary:    '#4c566a',
      text_primary:   '#eceff4',
      text_secondary: '#d8dee9',
    } as BaseColors,
  },
  {
    name: 'Starlake',
    accent: '#cba6f7',
    hover: '#d4b2f8',
    base: {
      bg_primary:     '#1e1e2e',
      bg_secondary:   '#181825',
      bg_tertiary:    '#313244',
      text_primary:   '#cdd6f4',
      text_secondary: '#6c7086',
    } as BaseColors,
  },
  {
    name: 'Sakura',
    accent: '#f4a7c3',
    hover: '#e090ae',
    base: {
      bg_primary:     '#fefcfd',
      bg_secondary:   '#f8eef2',
      bg_tertiary:    '#efd8e4',
      text_primary:   '#1c0a12',
      text_secondary: '#7a5868',
    } as BaseColors,
  },
  {
    name: 'Ocean',
    accent: '#0ea5e9',
    hover: '#38bdf8',
    base: {
      bg_primary:     '#020c1a',
      bg_secondary:   '#051828',
      bg_tertiary:    '#0a2d48',
      text_primary:   '#e0f2fe',
      text_secondary: '#4a8fa8',
    } as BaseColors,
  },
  {
    name: 'Claude',
    accent: '#c4704f',
    hover: '#d4845f',
    base: {
      bg_primary:     '#1c1917',
      bg_secondary:   '#292524',
      bg_tertiary:    '#3d3834',
      text_primary:   '#f5f0eb',
      text_secondary: '#a09888',
    } as BaseColors,
  },
  {
    name: 'Phantom',
    accent: '#10b981',
    hover: '#34d399',
    base: {
      bg_primary:     '#09091a',
      bg_secondary:   '#0f0f22',
      bg_tertiary:    '#1a1a35',
      text_primary:   '#ccd6f6',
      text_secondary: '#495670',
    } as BaseColors,
  },
];

function isValidThemeFile(data: unknown): data is ThemeFile {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.accent !== 'string') return false;
  if (!d.base || typeof d.base !== 'object') return false;
  const b = d.base as Record<string, unknown>;
  return ['bg_primary', 'bg_secondary', 'bg_tertiary', 'text_primary', 'text_secondary']
    .every(k => typeof b[k] === 'string');
}

type SettingsTab = 'appearance' | 'language' | 'account' | 'ai' | 'users';

/** Vertical section list (desktop) with the spring highlight. */
function SectionNav({ sections, active, onChange }: { sections: { id: SettingsTab; label: string; icon: React.ReactNode }[]; active: SettingsTab; onChange: (t: SettingsTab) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const spring = useSpring<'y' | 'h'>(({ y, h }) => { if (pill.current) { pill.current.style.transform = `translateY(${y}px)`; pill.current.style.height = `${h}px`; } });
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!el) return;
    spring.set({ y: el.offsetTop, h: el.offsetHeight }, first.current);
    first.current = false;
  }, [active, spring, sections.length]);
  return (
    <nav ref={box} className="hidden lg:block relative card !p-2 lg:sticky lg:top-4">
      <span ref={pill} aria-hidden className="absolute left-2 right-2 top-0 rounded-lg bg-(--accent)/15 pointer-events-none" style={{ height: 0 }} />
      {sections.map(x => (
        <button key={x.id} data-tab={x.id} onClick={() => onChange(x.id)}
          className={`relative w-full flex items-center gap-2.5 px-3 h-10 rounded-lg text-sm font-medium transition-colors ${active === x.id ? 'text-white' : 'text-(--text-secondary) hover:text-white'}`}>
          <span className={active === x.id ? 'text-(--accent)' : ''}>{x.icon}</span>
          <span className="flex-1 text-left">{x.label}</span>
          {active === x.id && <ChevronRight className="w-3.5 h-3.5 opacity-60" />}
        </button>
      ))}
    </nav>
  );
}

/** AI writer + API keys (same panel as the Story tab). */
function AiSection() {
  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({});
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [choice, setChoice] = useState<AiChoice>(() => { try { return JSON.parse(localStorage.getItem('story-ai') || '{}'); } catch { return { provider: '', model: '' }; } });
  const [open, setOpen] = useState(false);
  const load = () => Promise.all([settingsApi.getProviders(), settingsApi.getApiKeys()]).then(([p, k]) => { setProviders(p.providers); setConfigured(k.configured); }).catch(() => {});
  useEffect(() => { load(); }, []);
  const pick = (c: AiChoice) => { setChoice(c); try { localStorage.setItem('story-ai', JSON.stringify(c)); } catch { /* storage unavailable */ } };
  const ready = Object.entries(providers).filter(([id]) => configured[id]);
  return (
    <section className="card space-y-4">
      <div>
        <h3 className="font-semibold">AI</h3>
        <p className="text-xs text-(--text-secondary) mt-0.5">Used for stories, reading lookups and explanations.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {Object.entries(providers).map(([id, info]) => (
          <div key={id} className="rounded-xl bg-(--bg-tertiary)/60 px-3 py-2.5 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{info.name}</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full ${configured[id] ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-(--text-secondary)'}`}>{configured[id] ? 'Connected' : 'Not set'}</span>
          </div>
        ))}
      </div>
      <p className="text-sm text-(--text-secondary)">
        {ready.length ? <>Writing with <span className="text-white">{providers[choice.provider]?.name ?? ready[0][1].name}</span>{choice.model ? ` · ${choice.model}` : ''}.</> : 'No AI key yet — add one to write stories.'}
      </p>
      <button onClick={() => setOpen(true)} className="btn btn-primary">Manage AI & keys</button>
      {open && <AiPanel providers={providers} configured={configured} choice={choice} onChoice={pick} onKeysChanged={load} onClose={() => setOpen(false)} />}
    </section>
  );
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as SettingsTab) || 'appearance';
  const setTab = (t: SettingsTab) => setSearchParams(t === 'appearance' ? {} : { tab: t }, { replace: true });
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [languageSuccess, setLanguageSuccess] = useState('');

  // Accent state
  const [accentColor, setAccentColor] = useState('#e94560');
  const [serverAccent, setServerAccent] = useState('#e94560');
  const [serverHover, setServerHover] = useState('#ff6b6b');
  const [accentSaving, setAccentSaving] = useState(false);

  // Base colors state
  const [personalBase, setPersonalBase] = useState<BaseColors>({ ...BASE_COLORS_DEFAULT });
  const [serverBase, setServerBase] = useState<BaseColors>({ ...BASE_COLORS_DEFAULT });
  const [baseColorsSaving, setBaseColorsSaving] = useState(false);

  // Shared mode toggle
  const [mode, setMode] = useState<ThemeMode>('personal');

  // Custom themes (localStorage)
  const [customThemes, setCustomThemes] = useState<ThemeEntry[]>(loadCustomThemes);
  const [deleteThemeModal, setDeleteThemeModal] = useState<{ index: number; name: string } | null>(null);

  // Import
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<ThemeFile | null>(null);
  const [importName, setImportName] = useState('');

  const canEditServer = !!(currentUser?.is_admin || currentUser?.can_edit_server_accent);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      const [user, serverTheme, serverBaseColors] = await Promise.all([
        auth.me(), themeApi.get(), themeApi.getBase(),
      ]);
      setCurrentUser(user);
      setServerAccent(serverTheme.accent);
      setServerHover(serverTheme.hover);
      setAccentColor(user.accent_color ?? serverTheme.accent);
      setServerBase({ ...BASE_COLORS_DEFAULT, ...serverBaseColors });
      setPersonalBase({ ...BASE_COLORS_DEFAULT, ...(user.base_colors ?? serverBaseColors) });
    } catch (err) { console.error('Failed to load settings:', err); }
  };

  // ── Accent ───────────────────────────────────────────────────────────────────

  const handleSavePersonalAccent = async (accent: string, hover?: string) => {
    const h = hover ?? serverHover;
    setAccentColor(accent);
    saveAccentColor(accent, h);
    setAccentSaving(true);
    try { await auth.setAccent(accent, h); await loadAll(); }
    finally { setAccentSaving(false); }
  };

  const handleResetAccent = async () => {
    setAccentSaving(true);
    try {
      const res = await auth.clearAccent();
      setAccentColor(res.accent);
      saveAccentColor(res.accent, res.hover);
      await loadAll();
    } finally { setAccentSaving(false); }
  };

  const handleSaveServerAccent = async (accent: string, hover?: string) => {
    const h = hover ?? serverHover;
    setServerAccent(accent); setServerHover(h);
    try {
      await themeApi.set(accent, h);
      await auth.setAccent(accent, h);
      setAccentColor(accent);
      saveAccentColor(accent, h);
    } catch (err) { console.error(err); }
  };

  // ── Base Colors ──────────────────────────────────────────────────────────────

  const handleSavePersonalBase = async (colors: BaseColors) => {
    setPersonalBase(colors);
    saveBaseColors(colors);
    setBaseColorsSaving(true);
    try { await auth.setBaseColors(colors); await loadAll(); }
    finally { setBaseColorsSaving(false); }
  };

  const handleResetBase = async () => {
    setBaseColorsSaving(true);
    try {
      const res = await auth.clearBaseColors();
      const c = { ...BASE_COLORS_DEFAULT, ...res } as BaseColors;
      setPersonalBase(c); saveBaseColors(c);
      await loadAll();
    } finally { setBaseColorsSaving(false); }
  };

  const handleSaveServerBase = async (colors: BaseColors) => {
    setServerBase(colors);
    setPersonalBase(colors);
    applyBaseColors(colors);
    try {
      await themeApi.setBase(colors);
      await auth.setBaseColors(colors);
      saveBaseColors(colors);
    } catch (err) { console.error(err); }
  };

  // ── Theme preset ─────────────────────────────────────────────────────────────

  const handleApplyTheme = async (th: ThemeEntry) => {
    if (mode === 'server') {
      await handleSaveServerAccent(th.accent, th.hover);
      await handleSaveServerBase(th.base);
    } else {
      await handleSavePersonalAccent(th.accent, th.hover);
      await handleSavePersonalBase(th.base);
    }
  };

  const isThemeActive = (th: ThemeEntry) => {
    const a = mode === 'server' ? serverAccent : accentColor;
    const b = mode === 'server' ? serverBase : personalBase;
    return a === th.accent && Object.entries(th.base).every(([k, v]) => b[k as keyof BaseColors] === v);
  };

  const handleConfirmDeleteTheme = () => {
    if (!deleteThemeModal) return;
    const updated = customThemes.filter((_, i) => i !== deleteThemeModal.index);
    setCustomThemes(updated);
    saveCustomThemes(updated);
    setDeleteThemeModal(null);
  };

  // ── Export / Import ──────────────────────────────────────────────────────────

  const handleExport = () => {
    const hover = getComputedStyle(document.documentElement).getPropertyValue('--accent-hover').trim();
    const payload: ThemeFile = {
      name: isServer ? 'Server Theme' : 'My Theme',
      version: 1,
      accent: activeAccent,
      hover: hover || activeAccent,
      base: activeBase,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ankibase-theme.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!isValidThemeFile(data)) throw new Error('Invalid theme file');
        setImportPreview({
          name: typeof data.name === 'string' ? data.name : 'Imported Theme',
          version: 1,
          accent: data.accent,
          hover: data.hover || data.accent,
          base: { ...BASE_COLORS_DEFAULT, ...data.base },
        });
        setImportName(typeof data.name === 'string' ? data.name : 'Imported Theme');
      } catch { /* invalid file */ }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleApplyImport = async () => {
    if (!importPreview) return;
    const entry: ThemeEntry = {
      name: importName.trim() || 'Imported Theme',
      accent: importPreview.accent,
      hover: importPreview.hover,
      base: importPreview.base,
    };
    const updated = [...customThemes, entry];
    setCustomThemes(updated);
    saveCustomThemes(updated);
    await handleSavePersonalAccent(entry.accent, entry.hover);
    await handleSavePersonalBase(entry.base);
    setImportPreview(null);
  };

  // ── Active pickers ───────────────────────────────────────────────────────────

  const isServer = mode === 'server';
  const activeAccent = isServer ? serverAccent : accentColor;
  const activeBase   = isServer ? serverBase   : personalBase;
  const isCustomAccent = ACCENT_PRESETS.every(p => p.accent !== activeAccent);

  const onPickAccentPreset = (accent: string, hover?: string) =>
    isServer ? handleSaveServerAccent(accent, hover) : handleSavePersonalAccent(accent, hover);

  const onChangeBase = (key: keyof BaseColors, value: string) => {
    const next = { ...activeBase, [key]: value };
    if (isServer) handleSaveServerBase(next);
    else handleSavePersonalBase(next);
  };

  // ── Language / password ───────────────────────────────────────────────────────

  const handleLanguageChange = async (newLanguage: string) => {
    setLanguageSuccess('');
    try {
      await auth.changeLanguage(newLanguage);
      i18n.changeLanguage(newLanguage);
      setLanguageSuccess(t('settings.languageChanged'));
      await loadAll();
      setTimeout(() => setLanguageSuccess(''), 3000);
    } catch (err) { console.error(err); }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (newPassword !== confirmPassword) { setError(t('settings.passwordMismatch')); return; }
    if (newPassword.length < 6) { setError(t('settings.passwordTooShort')); return; }
    setLoading(true);
    try {
      await auth.changePassword(currentPassword, newPassword);
      setSuccess(t('settings.passwordChanged'));
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setTimeout(async () => { await auth.logout(); navigate('/login'); }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally { setLoading(false); }
  };

  // ── Theme card ───────────────────────────────────────────────────────────────

  const ThemeCard = ({ th, customIndex }: { th: ThemeEntry; customIndex?: number }) => {
    const active = isThemeActive(th);
    return (
      <div className="relative group/card flex flex-col items-center gap-2">
        <button
          onClick={() => handleApplyTheme(th)}
          className={`theme-card relative rounded-xl overflow-hidden w-20 h-20${active ? ' theme-card-active' : ''}`}
          style={{ '--card-accent': th.accent } as React.CSSProperties}
        >
          <div className="absolute inset-0 flex flex-col">
            <div className="flex-1" style={{ background: th.base.bg_primary }} />
            <div className="flex-1" style={{ background: th.base.bg_secondary }} />
            <div className="flex-1" style={{ background: th.base.bg_tertiary }} />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <Logo className="w-9 h-9" color={th.accent} />
          </div>
        </button>
        <span className="text-xs text-(--text-secondary) group-hover/card:text-(--text-primary) transition-colors">
          {th.name}
        </span>
        {customIndex !== undefined && (
          <button
            onClick={() => setDeleteThemeModal({ index: customIndex, name: th.name })}
            className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-(--bg-tertiary) border border-(--bg-tertiary) text-(--text-secondary) hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/40 transition-all items-center justify-center hidden group-hover/card:flex"
            title="Delete theme"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  };

  const sections: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'appearance', label: 'Appearance', icon: <Palette className="w-4 h-4" /> },
    { id: 'language', label: t('settings.language'), icon: <Globe className="w-4 h-4" /> },
    { id: 'account', label: 'Account', icon: <UserIcon className="w-4 h-4" /> },
    { id: 'ai', label: 'AI', icon: <Sparkles className="w-4 h-4" /> },
    ...(currentUser?.is_admin ? [{ id: 'users' as const, label: 'Users', icon: <Users className="w-4 h-4" /> }] : []),
  ];
  const active = sections.some(x => x.id === tab) ? tab : 'appearance';

  const colorRow = (key: keyof BaseColors, label: string) => (
    <label key={key} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 cursor-pointer transition-colors">
      <span className="color-swatch relative w-7 h-7 rounded-full shrink-0" style={{ background: activeBase[key], '--swatch-color': activeBase[key] } as React.CSSProperties}>
        <input type="color" value={activeBase[key]} onChange={e => onChangeBase(key, e.target.value)}
          disabled={baseColorsSaving} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full rounded-full" />
      </span>
      <span className="text-sm flex-1">{label}</span>
      <span className="text-xs font-mono text-(--text-secondary)">{activeBase[key]}</span>
    </label>
  );

  return (
    <div className="max-w-5xl mx-auto pb-10 space-y-5">
      <div>
        <h2 className="text-xl font-bold">Settings</h2>
        <p className="text-sm text-(--text-secondary) mt-0.5">{currentUser ? <>Signed in as <span className="text-white">{currentUser.username}</span>{currentUser.is_admin ? ' · admin' : ''}</> : ' '}</p>
      </div>

      {/* Phones: a slider of sections */}
      <div className="lg:hidden overflow-x-auto -mx-4 px-4">
        <Segmented size="md" value={active} onChange={v => setTab(v)} options={sections.map(x => ({ value: x.id, label: x.label, icon: x.icon }))} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[13rem_minmax(0,1fr)] gap-6 items-start">
        <SectionNav sections={sections} active={active} onChange={setTab} />

        <div key={active} className="space-y-5 min-w-0 anim-rise">
          {active === 'appearance' && (<>
            <section className="card space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">Theme</h3>
                  <p className="text-xs text-(--text-secondary) mt-0.5">{isServer ? 'Editing the default everyone sees until they pick their own.' : 'Only changes how AnkiBase looks for you.'}</p>
                </div>
                <div className="flex items-center gap-2">
                  {canEditServer && (
                    <Segmented value={mode} onChange={v => setMode(v)} options={[{ value: 'personal', label: 'Mine' }, { value: 'server', label: 'Server default' }]} />
                  )}
                  <button onClick={handleExport} title="Export theme" className="w-8 h-8 rounded-lg bg-(--bg-tertiary) flex items-center justify-center text-(--text-secondary) hover:text-white"><Download className="w-4 h-4" /></button>
                  <button onClick={() => fileInputRef.current?.click()} title="Import theme" className="w-8 h-8 rounded-lg bg-(--bg-tertiary) flex items-center justify-center text-(--text-secondary) hover:text-white"><Upload className="w-4 h-4" /></button>
                  <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
                </div>
              </div>
              <div className="flex flex-wrap gap-4">
                {BUILTIN_THEMES.map(th => <ThemeCard key={th.name} th={th} />)}
                {customThemes.map((th, i) => <ThemeCard key={`custom-${i}`} th={th} customIndex={i} />)}
              </div>
            </section>

            <section className="card space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">Accent color</h3>
                  <p className="text-xs text-(--text-secondary) mt-0.5">Buttons, highlights and charts.</p>
                </div>
                {!isServer && currentUser?.has_personal_accent && (
                  <button onClick={handleResetAccent} disabled={accentSaving} className="flex items-center gap-1.5 text-xs text-(--text-secondary) hover-accent transition-colors">
                    <RotateCcw className="w-3 h-3" /> Reset
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                {ACCENT_PRESETS.map(p => (
                  <button key={p.name} onClick={() => onPickAccentPreset(p.accent, p.hover)} className="flex flex-col items-center gap-1.5 group w-12" disabled={accentSaving}>
                    <span className={`color-swatch w-8 h-8 rounded-full transition-all${activeAccent === p.accent ? ' color-swatch-active' : ''}`}
                      style={{ background: p.accent, '--swatch-color': p.accent } as React.CSSProperties} />
                    <span className="text-[11px] text-(--text-secondary) group-hover:text-(--text-primary) transition-colors leading-none">{p.name}</span>
                  </button>
                ))}
                <label className="flex flex-col items-center gap-1.5 w-12 cursor-pointer">
                  <span className={`color-swatch relative w-8 h-8 rounded-full shrink-0${isCustomAccent ? ' color-swatch-active' : ''}`}
                    style={{ background: isCustomAccent ? activeAccent : 'conic-gradient(#f87171,#fbbf24,#4ade80,#60a5fa,#c084fc,#f87171)', '--swatch-color': activeAccent } as React.CSSProperties}>
                    <input type="color" value={activeAccent} onChange={e => onPickAccentPreset(e.target.value)} disabled={accentSaving}
                      className="absolute inset-0 opacity-0 cursor-pointer w-full h-full rounded-full" />
                  </span>
                  <span className="text-[11px] text-(--text-secondary) leading-none">{isCustomAccent ? activeAccent : 'Custom'}</span>
                </label>
              </div>
            </section>

            <section className="card space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">Colors</h3>
                  <p className="text-xs text-(--text-secondary) mt-0.5">Fine-tune the backgrounds and text. Changes apply instantly.</p>
                </div>
                {!isServer && currentUser?.has_personal_base_colors && (
                  <button onClick={handleResetBase} disabled={baseColorsSaving} className="flex items-center gap-1.5 text-xs text-(--text-secondary) hover-accent transition-colors">
                    <RotateCcw className="w-3 h-3" /> Reset
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_14rem] gap-5 items-start">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  <p className="sm:col-span-2 text-[11px] font-semibold uppercase tracking-wider text-(--text-secondary) px-2 pt-1">Backgrounds</p>
                  {BG_FIELDS.map(({ key, label }) => colorRow(key, label))}
                  <p className="sm:col-span-2 text-[11px] font-semibold uppercase tracking-wider text-(--text-secondary) px-2 pt-3">Text</p>
                  {TEXT_FIELDS.map(({ key, label }) => colorRow(key, label))}
                </div>
                {/* Live preview */}
                <div className="rounded-xl overflow-hidden border border-white/10 text-left" style={{ background: activeBase.bg_primary }}>
                  <div className="px-3 py-2 flex items-center gap-2" style={{ background: activeBase.bg_secondary }}>
                    <Logo className="w-4 h-4" color={activeAccent} />
                    <span className="text-xs font-semibold" style={{ color: activeAccent }}>AnkiBase</span>
                  </div>
                  <div className="p-3 space-y-2">
                    <div className="rounded-lg p-3 space-y-1.5" style={{ background: activeBase.bg_secondary }}>
                      <p className="text-sm font-semibold" style={{ color: activeBase.text_primary }}>le chat</p>
                      <p className="text-xs" style={{ color: activeBase.text_secondary }}>the cat · noun, masculine</p>
                      <div className="flex gap-1.5 pt-1">
                        <span className="h-6 px-2.5 rounded-md text-[11px] font-medium flex items-center text-white" style={{ background: activeAccent }}>Good</span>
                        <span className="h-6 px-2.5 rounded-md text-[11px] flex items-center" style={{ background: activeBase.bg_tertiary, color: activeBase.text_secondary }}>Again</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-center" style={{ color: activeBase.text_secondary }}>Preview</p>
                  </div>
                </div>
              </div>
            </section>
          </>)}

          {active === 'language' && (
            <section className="card space-y-4">
              <div>
                <h3 className="font-semibold">{t('settings.language')}</h3>
                <p className="text-xs text-(--text-secondary) mt-0.5">{t('settings.languageDescription')}</p>
              </div>
              <Segmented size="md" value={currentUser?.language === 'de' ? 'de' : 'en'} onChange={v => handleLanguageChange(v)}
                options={[{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }]} />
              {languageSuccess && <p className="text-sm text-green-400 flex items-center gap-2 anim-rise"><Check className="w-4 h-4" />{languageSuccess}</p>}
            </section>
          )}

          {active === 'account' && (<>
            <section className="card">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-(--accent)/15 text-(--accent) flex items-center justify-center text-lg font-bold uppercase shrink-0">
                  {currentUser?.username?.[0] ?? '?'}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold truncate">{currentUser?.username}</p>
                  <p className="text-xs text-(--text-secondary)">
                    {currentUser?.is_admin ? 'Administrator' : 'Member'}{currentUser?.can_add_containers ? ' · can add Anki accounts' : ''}
                  </p>
                </div>
              </div>
            </section>
            <section className="card space-y-4">
              <div>
                <h3 className="font-semibold">{t('settings.changePassword')}</h3>
                <p className="text-xs text-(--text-secondary) mt-0.5">{t('settings.passwordDescription')}</p>
              </div>
              {error && <p className="text-sm text-(--error) anim-rise">{error}</p>}
              {success && <p className="text-sm text-green-400 flex items-center gap-2 anim-rise"><Check className="w-4 h-4" />{success}</p>}
              <form onSubmit={handlePasswordReset} className="space-y-3 max-w-md">
                <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoComplete="current-password"
                  placeholder={t('settings.currentPasswordPlaceholder')} className="input w-full" required disabled={loading} aria-label={t('settings.currentPassword')} />
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password"
                  placeholder={t('settings.newPasswordPlaceholder')} className="input w-full" required disabled={loading} aria-label={t('settings.newPassword')} />
                <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password"
                  placeholder={t('settings.confirmPasswordPlaceholder')} className="input w-full" required disabled={loading} aria-label={t('settings.confirmPassword')} />
                <button type="submit" disabled={loading} className="btn btn-primary">{loading ? t('settings.changingPassword') : t('settings.changePassword')}</button>
              </form>
            </section>
          </>)}

          {active === 'ai' && <AiSection />}
          {active === 'users' && currentUser?.is_admin && <UserManagement />}
        </div>
      </div>

      {/* ── Delete custom theme confirmation ────────────────────────────── */}
      {deleteThemeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">Delete Theme</h3>
              <button onClick={() => setDeleteThemeModal(null)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-(--text-secondary) mb-4">
              Delete "<span className="text-(--text-primary) font-medium">{deleteThemeModal.name}</span>"? This can't be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteThemeModal(null)} className="btn btn-secondary">
                Cancel
              </button>
              <button onClick={handleConfirmDeleteTheme} className="btn btn-error">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Import preview modal ─────────────────────────────────────────── */}
      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="card max-w-sm w-full space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Import Theme</h3>
              <button onClick={() => setImportPreview(null)} className="icon-btn">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-4">
              <div
                className="theme-card theme-card-active relative w-20 h-20 rounded-xl overflow-hidden shrink-0"
                style={{ '--card-accent': importPreview.accent } as React.CSSProperties}
              >
                <div className="absolute inset-0 flex flex-col">
                  <div className="flex-1" style={{ background: importPreview.base.bg_primary }} />
                  <div className="flex-1" style={{ background: importPreview.base.bg_secondary }} />
                  <div className="flex-1" style={{ background: importPreview.base.bg_tertiary }} />
                </div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <Logo className="w-9 h-9" color={importPreview.accent} />
                </div>
              </div>
              <div className="space-y-1 text-xs font-mono text-(--text-secondary)">
                {([
                  ['Accent', importPreview.accent],
                  ['BG', importPreview.base.bg_primary],
                  ['Card', importPreview.base.bg_secondary],
                  ['Border', importPreview.base.bg_tertiary],
                ] as [string, string][]).map(([label, val]) => (
                  <div key={label} className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ background: val }} />
                    <span>{label}</span>
                    <span>{val}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Theme name</label>
              <input type="text" value={importName} onChange={e => setImportName(e.target.value)}
                className="input w-full" placeholder="My Theme" />
            </div>
            <div className="flex gap-3">
              <button onClick={handleApplyImport} className="btn btn-primary flex-1">Apply & Save</button>
              <button onClick={() => setImportPreview(null)} className="btn btn-secondary flex-1">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
