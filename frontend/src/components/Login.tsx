import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { auth, setup, theme as themeApi } from '../api';

import { Logo } from './Logo';
import { applyAccentColor, saveAccentColor, applyBaseColors, saveBaseColors } from '../hooks/useAccentColor';

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setup.status().then(s => {
      if (s.needs_setup || !s.has_container) navigate('/setup', { replace: true });
    }).catch(() => {});
    // Apply server colors only when localStorage has no personal theme.
    if (!localStorage.getItem('ankibase-accent'))
      themeApi.get().then(t => applyAccentColor(t.accent, t.hover)).catch(() => {});
    if (!localStorage.getItem('ankibase-base-colors'))
      themeApi.getBase().then(c => applyBaseColors(c)).catch(() => {});
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await auth.login(username, password);
      // Seed localStorage from server only when empty (new device).
      // If localStorage already has data, trust it — don't overwrite with potentially stale server data.
      try {
        const noLocalAccent = !localStorage.getItem('ankibase-accent');
        const noLocalBase = !localStorage.getItem('ankibase-base-colors');
        if (noLocalAccent || noLocalBase) {
          const me = await auth.me();
          if (noLocalAccent && me.accent_color) saveAccentColor(me.accent_color, me.accent_hover ?? undefined);
          if (noLocalBase && me.base_colors) saveBaseColors(me.base_colors);
        }
      } catch {}
      navigate('/', { replace: true });
    } catch {
      setError(t('login.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-(--bg-primary)">
      <div className="card w-full max-w-md">
        <div className="flex items-center justify-center mb-6">
          <Logo className="w-16 h-16" />
        </div>
        <h1 className="text-2xl font-bold text-center mb-6">AnkiBase</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('login.username')}
              className="input w-full"
              autoFocus
              required
            />
          </div>

          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.password')}
              className="input w-full pr-10 password-input"
              required
            />
            {password && (
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white cursor-pointer hover-opacity-80 transition-opacity"
              >
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            )}
          </div>

          {error && (
            <p className="text-(--error) text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary w-full"
          >
            {loading ? t('login.loggingIn') : t('login.loginButton')}
          </button>
        </form>
      </div>
    </div>
  );
}
