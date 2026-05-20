import { useState, useEffect } from 'react';
import { Key, Globe, Palette } from 'lucide-react';
import { auth, type User } from '../api';
import { useNavigate } from 'react-router-dom';
import { UserManagement } from '../components/UserManagement';
import { useTranslation } from 'react-i18next';
import { ACCENT_PRESETS, getAccentColor, saveAccentColor } from '../hooks/useAccentColor';

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
  const [accentColor, setAccentColor] = useState(() => getAccentColor().accent);

  useEffect(() => {
    loadCurrentUser();
  }, []);

  const loadCurrentUser = async () => {
    try {
      const user = await auth.me();
      setCurrentUser(user);
    } catch (err) {
      console.error('Failed to load current user:', err);
    }
  };

  const handleLanguageChange = async (newLanguage: string) => {
    setLanguageSuccess('');
    try {
      await auth.changeLanguage(newLanguage);
      i18n.changeLanguage(newLanguage);
      setLanguageSuccess(t('settings.languageChanged'));
      // Reload user data
      await loadCurrentUser();
      // Clear success message after 3 seconds
      setTimeout(() => setLanguageSuccess(''), 3000);
    } catch (err) {
      console.error('Failed to change language:', err);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    // Validation
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

      // Log out after 2 seconds
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

  return (
    <div className={currentUser?.is_admin ? "max-w-7xl mx-auto" : "max-w-2xl mx-auto"}>
      <div className="space-y-6">
        {/* Accent Color */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Palette className="w-5 h-5 text-(--accent)" />
            <h2 className="text-xl font-semibold">Accent Color</h2>
          </div>

          <div className="space-y-4">
            {/* Presets */}
            <div className="flex flex-wrap gap-4">
              {ACCENT_PRESETS.map(p => (
                <button
                  key={p.name}
                  onClick={() => { saveAccentColor(p.accent, p.hover); setAccentColor(p.accent); }}
                  className="flex flex-col items-center gap-1.5 group w-12"
                  title={p.name}
                >
                  <div
                    className="w-8 h-8 rounded-full transition-all"
                    style={{
                      background: p.accent,
                      boxShadow: accentColor === p.accent
                        ? `0 0 0 2px var(--bg-primary), 0 0 0 4px ${p.accent}`
                        : 'none',
                    }}
                  />
                  <span className="text-xs text-(--text-secondary) group-hover:text-(--text-primary) transition-colors">{p.name}</span>
                </button>
              ))}
            </div>

            {/* Custom picker */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-(--text-secondary) shrink-0">Custom</label>
              <div className="relative">
                <input
                  type="color"
                  value={accentColor}
                  onChange={e => { saveAccentColor(e.target.value); setAccentColor(e.target.value); }}
                  className="w-10 h-10 rounded-lg cursor-pointer border-2 border-(--bg-tertiary) bg-transparent p-0.5"
                />
              </div>
              <span className="text-sm font-mono text-(--text-secondary)">{accentColor}</span>
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

          {/* Language Success */}
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

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">
              {success}
            </div>
          )}

          <form onSubmit={handlePasswordReset} className="space-y-4">
            {/* Current Password */}
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

            {/* New Password */}
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

            {/* Confirm New Password */}
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

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full"
            >
              {loading ? t('settings.changingPassword') : t('settings.changePassword')}
            </button>
          </form>
        </div>

        {/* Right: User Management Section (Admin only) */}
        {currentUser?.is_admin && (
          <div>
            <UserManagement />
          </div>
        )}
      </div>
    </div>
  );
}
