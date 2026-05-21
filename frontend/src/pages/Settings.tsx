import { useState, useEffect, useRef } from 'react';
import { Key, Globe, Palette, RotateCcw, X, Download, Upload, Trash2 } from 'lucide-react';
import { auth, theme as themeApi, type User } from '../api';
import { useNavigate } from 'react-router-dom';
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

export function Settings() {
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
      // Mirror server changes to personal so the user's own view stays in sync
      await auth.setAccent(accent, h);
      setAccentColor(accent);
      saveAccentColor(accent, h);
      await loadAll();
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
    applyBaseColors(colors); // apply visually; don't write localStorage yet
    try {
      await themeApi.setBase(colors);
      // Mirror server changes to personal so the user's own view stays in sync
      await auth.setBaseColors(colors);
      saveBaseColors(colors);
      await loadAll();
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

  return (
    <div className={currentUser?.is_admin ? "max-w-7xl mx-auto" : "max-w-2xl mx-auto"}>
      <div className="space-y-6">

        {/* ── Theme card ─────────────────────────────────────────────────── */}
        <div className="card space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Palette className="w-5 h-5 text-(--accent)" />
              <h2 className="text-xl font-semibold">Theme</h2>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleExport} className="btn btn-secondary flex items-center gap-1.5 text-sm py-1.5 px-3">
                <Download className="w-3.5 h-3.5" />
                Export
              </button>
              <button onClick={() => fileInputRef.current?.click()} className="btn btn-secondary flex items-center gap-1.5 text-sm py-1.5 px-3">
                <Upload className="w-3.5 h-3.5" />
                Import
              </button>
              <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
              {canEditServer && (
                <select
                  value={mode}
                  onChange={e => setMode(e.target.value as ThemeMode)}
                  className="input text-sm py-1 px-2 h-auto"
                >
                  <option value="personal">Personal</option>
                  <option value="server">Server default</option>
                </select>
              )}
            </div>
          </div>

          {/* Themes */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-(--text-secondary) mb-3">Themes</p>
            <div className="flex flex-wrap gap-4">
              {BUILTIN_THEMES.map(th => (
                <ThemeCard key={th.name} th={th} />
              ))}
              {customThemes.map((th, i) => (
                <ThemeCard key={`custom-${i}`} th={th} customIndex={i} />
              ))}
            </div>
          </div>

          {/* Accent Color */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-(--text-secondary)">Accent Color</p>
              {!isServer && currentUser?.has_personal_accent && (
                <button
                  onClick={handleResetAccent}
                  disabled={accentSaving}
                  className="flex items-center gap-1.5 text-xs text-(--text-secondary) hover-accent transition-colors"
                >
                  <RotateCcw className="w-3 h-3" /> Reset
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              {ACCENT_PRESETS.map(p => (
                <button
                  key={p.name}
                  onClick={() => onPickAccentPreset(p.accent, p.hover)}
                  className="flex flex-col items-center gap-1 group w-10"
                  disabled={accentSaving}
                >
                  <div
                    className={`color-swatch w-7 h-7 rounded-full transition-all${activeAccent === p.accent ? ' color-swatch-active' : ''}`}
                    style={{
                      background: p.accent,
                      '--swatch-color': p.accent,
                    } as React.CSSProperties}
                  />
                  <span className="text-xs text-(--text-secondary) group-hover:text-(--text-primary) transition-colors leading-none">{p.name}</span>
                </button>
              ))}
              {/* Custom — inline with presets */}
              <div className="flex flex-col items-center gap-1 w-10">
                <div
                  className={`color-swatch relative w-7 h-7 rounded-full shrink-0 cursor-pointer${isCustomAccent ? ' color-swatch-active' : ''}`}
                  style={{
                    background: activeAccent,
                    '--swatch-color': activeAccent,
                  } as React.CSSProperties}
                >
                  <input
                    type="color"
                    value={activeAccent}
                    onChange={e => onPickAccentPreset(e.target.value)}
                    disabled={accentSaving}
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full rounded-full"
                  />
                </div>
                <span className="text-xs text-(--text-secondary) leading-none">Custom</span>
                {isCustomAccent && (
                  <span className="text-[10px] font-mono text-(--text-secondary) leading-none">{activeAccent}</span>
                )}
              </div>
            </div>
          </div>

          {/* Base Colors */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-(--text-secondary)">Base Colors</p>
              {!isServer && currentUser?.has_personal_base_colors && (
                <button
                  onClick={handleResetBase}
                  disabled={baseColorsSaving}
                  className="flex items-center gap-1.5 text-xs text-(--text-secondary) hover-accent transition-colors"
                >
                  <RotateCcw className="w-3 h-3" /> Reset
                </button>
              )}
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-(--text-secondary) mb-2">Backgrounds</p>
                <div className="space-y-2">
                  {BG_FIELDS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-3">
                      <div
                        className="color-swatch relative w-7 h-7 rounded-full shrink-0 cursor-pointer"
                        style={{ background: activeBase[key], '--swatch-color': activeBase[key] } as React.CSSProperties}
                      >
                        <input type="color" value={activeBase[key]} onChange={e => onChangeBase(key, e.target.value)}
                          disabled={baseColorsSaving} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full rounded-full" />
                      </div>
                      <span className="text-sm text-(--text-secondary) w-28 shrink-0">{label}</span>
                      <span className="text-xs font-mono text-(--text-secondary)">{activeBase[key]}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-(--text-secondary) mb-2">Text</p>
                <div className="space-y-2">
                  {TEXT_FIELDS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-3">
                      <div
                        className="color-swatch relative w-7 h-7 rounded-full shrink-0 cursor-pointer"
                        style={{ background: activeBase[key], '--swatch-color': activeBase[key] } as React.CSSProperties}
                      >
                        <input type="color" value={activeBase[key]} onChange={e => onChangeBase(key, e.target.value)}
                          disabled={baseColorsSaving} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full rounded-full" />
                      </div>
                      <span className="text-sm text-(--text-secondary) w-28 shrink-0">{label}</span>
                      <span className="text-xs font-mono text-(--text-secondary)">{activeBase[key]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Language */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-5 h-5 text-(--accent)" />
            <h2 className="text-xl font-semibold">{t('settings.language')}</h2>
          </div>
          <p className="text-(--text-secondary) text-sm mb-6">{t('settings.languageDescription')}</p>
          {languageSuccess && (
            <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">{languageSuccess}</div>
          )}
          <div>
            <label className="block text-sm font-medium mb-2">{t('settings.selectLanguage')}</label>
            <select value={currentUser?.language || 'en'} onChange={e => handleLanguageChange(e.target.value)} className="input w-full">
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
        </div>

        {/* Password */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Key className="w-5 h-5 text-(--accent)" />
            <h2 className="text-xl font-semibold">{t('settings.changePassword')}</h2>
          </div>
          <p className="text-(--text-secondary) text-sm mb-6">{t('settings.passwordDescription')}</p>
          {error && <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">{error}</div>}
          {success && <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">{success}</div>}
          <form onSubmit={handlePasswordReset} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">{t('settings.currentPassword')}</label>
              <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)}
                placeholder={t('settings.currentPasswordPlaceholder')} className="input w-full" required disabled={loading} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t('settings.newPassword')}</label>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                placeholder={t('settings.newPasswordPlaceholder')} className="input w-full" required disabled={loading} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t('settings.confirmPassword')}</label>
              <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                placeholder={t('settings.confirmPasswordPlaceholder')} className="input w-full" required disabled={loading} />
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary w-full">
              {loading ? t('settings.changingPassword') : t('settings.changePassword')}
            </button>
          </form>
        </div>

        {/* User Management */}
        {currentUser?.is_admin && <UserManagement />}
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
