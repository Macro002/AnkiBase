import { useState, useEffect } from 'react';
import { Key, Globe, Palette, RotateCcw } from 'lucide-react';
import { auth, theme as themeApi, type User } from '../api';
import { useNavigate } from 'react-router-dom';
import { UserManagement } from '../components/UserManagement';
import { useTranslation } from 'react-i18next';
import {
  ACCENT_PRESETS, saveAccentColor,
  BASE_COLORS_DEFAULT, saveBaseColors, type BaseColors,
} from '../hooks/useAccentColor';

type ThemeMode = 'personal' | 'server';

interface BaseColorField {
  key: keyof BaseColors;
  label: string;
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

const THEMES = [
  {
    name: 'AnkiBase',
    accent: '#e94560',
    hover: '#ff6b6b',
    base: BASE_COLORS_DEFAULT,
  },
];

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

  // Shared mode toggle (affects both accent and base colors)
  const [mode, setMode] = useState<ThemeMode>('personal');

  const canEditServer = !!(currentUser?.is_admin || currentUser?.can_edit_server_accent);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      const [user, serverTheme, serverBaseColors] = await Promise.all([
        auth.me(),
        themeApi.get(),
        themeApi.getBase(),
      ]);
      setCurrentUser(user);
      setServerAccent(serverTheme.accent);
      setServerHover(serverTheme.hover);
      setAccentColor(user.accent_color ?? serverTheme.accent);
      setServerBase({ ...BASE_COLORS_DEFAULT, ...serverBaseColors });
      setPersonalBase({ ...BASE_COLORS_DEFAULT, ...(user.base_colors ?? serverBaseColors) });
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  // ── Accent handlers ─────────────────────────────────────────────────────────

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
    setServerAccent(accent);
    setServerHover(h);
    try {
      await themeApi.set(accent, h);
      if (!currentUser?.has_personal_accent) {
        setAccentColor(accent);
        saveAccentColor(accent, h);
      }
    } catch (err) { console.error(err); }
  };

  // ── Base color handlers ──────────────────────────────────────────────────────

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
      const c = { ...BASE_COLORS_DEFAULT, ...res };
      setPersonalBase(c as BaseColors);
      saveBaseColors(c);
      await loadAll();
    } finally { setBaseColorsSaving(false); }
  };

  const handleSaveServerBase = async (colors: BaseColors) => {
    setServerBase(colors);
    saveBaseColors(colors);
    try {
      await themeApi.setBase(colors);
      if (!currentUser?.has_personal_base_colors) saveBaseColors(colors);
    } catch (err) { console.error(err); }
  };

  // ── Theme preset ─────────────────────────────────────────────────────────────

  const handleApplyTheme = async (th: typeof THEMES[0]) => {
    if (mode === 'server') {
      await handleSaveServerAccent(th.accent, th.hover);
      await handleSaveServerBase(th.base);
    } else {
      await handleSavePersonalAccent(th.accent, th.hover);
      await handleSavePersonalBase(th.base);
    }
  };

  const isThemeActive = (th: typeof THEMES[0]) => {
    const activeAccent = mode === 'server' ? serverAccent : accentColor;
    const activeBase = mode === 'server' ? serverBase : personalBase;
    return activeAccent === th.accent
      && Object.entries(th.base).every(([k, v]) => activeBase[k as keyof BaseColors] === v);
  };

  // ── Active pickers ───────────────────────────────────────────────────────────

  const isServer = mode === 'server';
  const activeAccent = isServer ? serverAccent : accentColor;
  const activeBase = isServer ? serverBase : personalBase;

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

          {/* Themes */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-(--text-secondary) mb-3">Themes</p>
            <div className="flex gap-3">
              {THEMES.map(th => (
                <button
                  key={th.name}
                  onClick={() => handleApplyTheme(th)}
                  className="flex flex-col items-center gap-2 group"
                >
                  {/* Mini palette preview */}
                  <div
                    className="w-16 h-16 rounded-xl overflow-hidden border-2 transition-all"
                    style={{
                      borderColor: isThemeActive(th) ? th.accent : 'var(--bg-tertiary)',
                      boxShadow: isThemeActive(th) ? `0 0 0 2px ${th.accent}` : 'none',
                    }}
                  >
                    <div className="w-full h-1/2" style={{ background: th.base.bg_primary }} />
                    <div className="w-full h-1/4" style={{ background: th.base.bg_secondary }} />
                    <div className="w-full h-1/4" style={{ background: th.accent }} />
                  </div>
                  <span className="text-xs text-(--text-secondary) group-hover:text-(--text-primary) transition-colors">
                    {th.name}
                  </span>
                </button>
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
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3">
                {ACCENT_PRESETS.map(p => (
                  <button
                    key={p.name}
                    onClick={() => onPickAccentPreset(p.accent, p.hover)}
                    className="flex flex-col items-center gap-1 group w-10"
                    title={p.name}
                    disabled={accentSaving}
                  >
                    <div
                      className="w-7 h-7 rounded-full transition-all"
                      style={{
                        background: p.accent,
                        boxShadow: activeAccent === p.accent
                          ? `0 0 0 2px var(--bg-primary), 0 0 0 4px ${p.accent}`
                          : 'none',
                      }}
                    />
                    <span className="text-xs text-(--text-secondary) group-hover:text-(--text-primary) transition-colors leading-none">{p.name}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm text-(--text-secondary) shrink-0">Custom</label>
                <input
                  type="color"
                  value={activeAccent}
                  onChange={e => onPickAccentPreset(e.target.value)}
                  className="w-9 h-9 rounded-lg cursor-pointer border-2 border-(--bg-tertiary) bg-transparent p-0.5"
                  disabled={accentSaving}
                />
                <span className="text-sm font-mono text-(--text-secondary)">{activeAccent}</span>
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
                      <input
                        type="color"
                        value={activeBase[key]}
                        onChange={e => onChangeBase(key, e.target.value)}
                        disabled={baseColorsSaving}
                        className="w-8 h-8 rounded-lg cursor-pointer border-2 border-(--bg-tertiary) bg-transparent p-0.5 shrink-0"
                      />
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
                      <input
                        type="color"
                        value={activeBase[key]}
                        onChange={e => onChangeBase(key, e.target.value)}
                        disabled={baseColorsSaving}
                        className="w-8 h-8 rounded-lg cursor-pointer border-2 border-(--bg-tertiary) bg-transparent p-0.5 shrink-0"
                      />
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
            <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">
              {languageSuccess}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-2">{t('settings.selectLanguage')}</label>
            <select
              value={currentUser?.language || 'en'}
              onChange={(e) => handleLanguageChange(e.target.value)}
              className="input w-full"
            >
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
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">{error}</div>
          )}
          {success && (
            <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">{success}</div>
          )}
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

        {/* User Management (admin only) */}
        {currentUser?.is_admin && <UserManagement />}
      </div>
    </div>
  );
}
