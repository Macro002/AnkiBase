import { useState, useEffect } from 'react';
import { Key, Globe, Palette, RotateCcw } from 'lucide-react';
import { auth, theme as themeApi, type User } from '../api';
import { useNavigate } from 'react-router-dom';
import { UserManagement } from '../components/UserManagement';
import { useTranslation } from 'react-i18next';
import { ACCENT_PRESETS, applyAccentColor } from '../hooks/useAccentColor';

type AccentMode = 'personal' | 'server';

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
  const [accentColor, setAccentColor] = useState('#e94560');
  const [serverAccent, setServerAccent] = useState('#e94560');
  const [serverHover, setServerHover] = useState('#ff6b6b');
  const [accentSaving, setAccentSaving] = useState(false);
  const [accentMode, setAccentMode] = useState<AccentMode>('personal');

  const canEditServer = !!(currentUser?.is_admin || currentUser?.can_edit_server_accent);

  useEffect(() => {
    loadCurrentUser();
  }, []);

  const loadCurrentUser = async () => {
    try {
      const [user, serverTheme] = await Promise.all([auth.me(), themeApi.get()]);
      setCurrentUser(user);
      setServerAccent(serverTheme.accent);
      setServerHover(serverTheme.hover);
      setAccentColor(user.accent_color ?? serverTheme.accent);
    } catch (err) {
      console.error('Failed to load current user:', err);
    }
  };

  const handleSavePersonalAccent = async (accent: string, hover?: string) => {
    const h = hover ?? serverHover;
    setAccentColor(accent);
    applyAccentColor(accent, h);
    setAccentSaving(true);
    try {
      await auth.setAccent(accent, h);
      await loadCurrentUser();
    } finally {
      setAccentSaving(false);
    }
  };

  const handleResetAccent = async () => {
    setAccentSaving(true);
    try {
      const res = await auth.clearAccent();
      setAccentColor(res.accent);
      applyAccentColor(res.accent, res.hover);
      await loadCurrentUser();
    } finally {
      setAccentSaving(false);
    }
  };

  const handleSaveServerAccent = async (accent: string, hover?: string) => {
    const h = hover ?? serverHover;
    setServerAccent(accent);
    setServerHover(h);
    try {
      await themeApi.set(accent, h);
      if (!currentUser?.has_personal_accent) {
        setAccentColor(accent);
        applyAccentColor(accent, h);
      }
    } catch (err) {
      console.error('Failed to save server accent:', err);
    }
  };

  const handleLanguageChange = async (newLanguage: string) => {
    setLanguageSuccess('');
    try {
      await auth.changeLanguage(newLanguage);
      i18n.changeLanguage(newLanguage);
      setLanguageSuccess(t('settings.languageChanged'));
      await loadCurrentUser();
      setTimeout(() => setLanguageSuccess(''), 3000);
    } catch (err) {
      console.error('Failed to change language:', err);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (newPassword !== confirmPassword) {
      setError(t('settings.passwordMismatch'));
      return;
    }

    if (newPassword.length < 6) {
      setError(t('settings.passwordTooShort'));
      return;
    }

    setLoading(true);

    try {
      await auth.changePassword(currentPassword, newPassword);
      setSuccess(t('settings.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      setTimeout(async () => {
        await auth.logout();
        navigate('/login');
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  const isServer = accentMode === 'server';
  const activeColor = isServer ? serverAccent : accentColor;
  const onPickPreset = isServer
    ? (accent: string, hover?: string) => handleSaveServerAccent(accent, hover)
    : (accent: string, hover?: string) => handleSavePersonalAccent(accent, hover);
  const onPickCustom = isServer
    ? (accent: string) => handleSaveServerAccent(accent)
    : (accent: string) => handleSavePersonalAccent(accent);

  return (
    <div className={currentUser?.is_admin ? "max-w-7xl mx-auto" : "max-w-2xl mx-auto"}>
      <div className="space-y-6">
        {/* Accent Color */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Palette className="w-5 h-5 text-(--accent)" />
              <h2 className="text-xl font-semibold">Accent Color</h2>
            </div>
            <div className="flex items-center gap-2">
              {!isServer && currentUser?.has_personal_accent && (
                <button
                  onClick={handleResetAccent}
                  disabled={accentSaving}
                  className="flex items-center gap-1.5 text-sm text-(--text-secondary) hover-accent transition-colors"
                  title="Reset to server default"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset
                </button>
              )}
              {canEditServer && (
                <select
                  value={accentMode}
                  onChange={e => setAccentMode(e.target.value as AccentMode)}
                  className="input text-sm py-1 px-2 h-auto"
                >
                  <option value="personal">Personal</option>
                  <option value="server">Server default</option>
                </select>
              )}
            </div>
          </div>

          {!isServer && !currentUser?.has_personal_accent && (
            <p className="text-xs text-(--text-secondary) mb-3">
              Using server default. Pick a color below to set your personal preference.
            </p>
          )}
          {isServer && (
            <p className="text-xs text-(--text-secondary) mb-3">
              This color is shown to all users who haven't set a personal override.
            </p>
          )}

          <div className="space-y-4">
            <div className="flex flex-wrap gap-4">
              {ACCENT_PRESETS.map(p => (
                <button
                  key={p.name}
                  onClick={() => onPickPreset(p.accent, p.hover)}
                  className="flex flex-col items-center gap-1.5 group w-12"
                  title={p.name}
                  disabled={accentSaving}
                >
                  <div
                    className="w-8 h-8 rounded-full transition-all"
                    style={{
                      background: p.accent,
                      boxShadow: activeColor === p.accent
                        ? `0 0 0 2px var(--bg-primary), 0 0 0 4px ${p.accent}`
                        : 'none',
                    }}
                  />
                  <span className="text-xs text-(--text-secondary) group-hover:text-(--text-primary) transition-colors">{p.name}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-(--text-secondary) shrink-0">Custom</label>
              <input
                type="color"
                value={activeColor}
                onChange={e => onPickCustom(e.target.value)}
                className="w-10 h-10 rounded-lg cursor-pointer border-2 border-(--bg-tertiary) bg-transparent p-0.5"
                disabled={accentSaving}
              />
              <span className="text-sm font-mono text-(--text-secondary)">{activeColor}</span>
            </div>
          </div>
        </div>

        {/* Language Selection */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-5 h-5 text-(--accent)" />
            <h2 className="text-xl font-semibold">{t('settings.language')}</h2>
          </div>

          <p className="text-(--text-secondary) text-sm mb-6">
            {t('settings.languageDescription')}
          </p>

          {languageSuccess && (
            <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">
              {languageSuccess}
            </div>
          )}

          <div className="space-y-4">
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
        </div>

        {/* Password Reset Section */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Key className="w-5 h-5 text-(--accent)" />
            <h2 className="text-xl font-semibold">{t('settings.changePassword')}</h2>
          </div>

          <p className="text-(--text-secondary) text-sm mb-6">
            {t('settings.passwordDescription')}
          </p>

          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">
              {success}
            </div>
          )}

          <form onSubmit={handlePasswordReset} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">{t('settings.currentPassword')}</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={t('settings.currentPasswordPlaceholder')}
                className="input w-full"
                required
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">{t('settings.newPassword')}</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('settings.newPasswordPlaceholder')}
                className="input w-full"
                required
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">{t('settings.confirmPassword')}</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t('settings.confirmPasswordPlaceholder')}
                className="input w-full"
                required
                disabled={loading}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full"
            >
              {loading ? t('settings.changingPassword') : t('settings.changePassword')}
            </button>
          </form>
        </div>

        {/* User Management (Admin only) */}
        {currentUser?.is_admin && (
          <div>
            <UserManagement />
          </div>
        )}
      </div>
    </div>
  );
}
