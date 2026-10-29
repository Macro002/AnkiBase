import { useState, useEffect } from 'react';
import { Eye, EyeOff, Server, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, auth, setup, theme as themeApi } from '../api';

import { Logo } from './Logo';
import { applyAccentColor, saveAccentColor, applyBaseColors, saveBaseColors } from '../hooks/useAccentColor';
import { appStatus, device, isNative, useAppStatus } from '../native';

const MAX_ATTEMPTS = 5;
const SS_UNTIL = 'ankibase-login-lockout';

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const app = useAppStatus();
  const [editingServer, setEditingServer] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [serverError, setServerError] = useState('');

  // Restore lockout from sessionStorage on mount
  useEffect(() => {
    const until = Number(sessionStorage.getItem(SS_UNTIL) ?? 0);
    if (until && Date.now() < until) {
      setLockedUntil(until);
    } else {
      sessionStorage.removeItem(SS_UNTIL);
    }
  }, []);

  useEffect(() => {
    setup.status().then(s => {
      if (s.needs_setup || !s.has_container) navigate('/setup', { replace: true });
    }).catch(() => {});
    if (!localStorage.getItem('ankibase-accent'))
      themeApi.get().then(t => applyAccentColor(t.accent, t.hover)).catch(() => {});
    if (!localStorage.getItem('ankibase-base-colors'))
      themeApi.getBase().then(c => applyBaseColors(c)).catch(() => {});
  }, [navigate]);

  // Countdown tick
  useEffect(() => {
    if (!lockedUntil) return;
    const tick = () => {
      const s = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (s <= 0) {
        setLockedUntil(null);
        setError('');
        sessionStorage.removeItem(SS_UNTIL);
      } else {
        setError(`Too many attempts. Try again in ${s}s.`);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const lock = (until: number) => {
    setLockedUntil(until);
    sessionStorage.setItem(SS_UNTIL, String(until));
  };

  const isLocked = !!lockedUntil;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked || loading) return;
    setError('');
    setLoading(true);

    try {
      await auth.login(username, password);
      try {
        const noLocalAccent = !localStorage.getItem('ankibase-accent');
        const noLocalBase = !localStorage.getItem('ankibase-base-colors');
        if (noLocalAccent || noLocalBase) {
          const me = await auth.me();
          if (noLocalAccent && me.accent_color) saveAccentColor(me.accent_color, me.accent_hover ?? undefined);
          if (noLocalBase && me.base_colors) saveBaseColors(me.base_colors);
        }
      } catch {}
      sessionStorage.removeItem(SS_UNTIL);
      navigate('/', { replace: true });

    } catch (err: unknown) {
      const e = err instanceof ApiError ? err : undefined;
      const waitSeconds = e?.waitSeconds;
      const remaining = e?.remaining;
      if (waitSeconds !== undefined) {
        lock(Date.now() + waitSeconds * 1000);
      } else if (remaining !== undefined) {
        setError(`Wrong username or password — ${MAX_ATTEMPTS - remaining}/${MAX_ATTEMPTS} attempts`);
      } else {
        setError('Wrong username or password');
      }
    } finally {
      setLoading(false);
    }
  };

  const inputCls = `input w-full${isLocked ? ' opacity-50 cursor-not-allowed' : ''}`;

  // The app: pick the server, or use the app without one.
  const saveServer = async (url: string | null) => {
    setServerError('');
    try {
      const next = await appStatus.setServer(url);
      setEditingServer(false);
      if (!next.server) window.location.replace('/');
      else if (!next.online) setServerError(`Couldn't reach ${next.server}. Check the address, or try again when you're online.`);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not change the server');
    }
  };
  const serverHost = app?.server ? app.server.replace(/^https?:\/\//, '') : '';

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-(--bg-primary) safe-pad-y">
      <div className="card w-full max-w-md">
        <div className="flex items-center justify-center mb-6">
          <Logo className="w-16 h-16" />
        </div>
        <h1 className="text-2xl font-bold text-center mb-2">AnkiBase</h1>
        {isNative ? (
          <div className="text-center mb-6">
            {editingServer ? (
              <form onSubmit={e => { e.preventDefault(); saveServer(serverUrl); }} className="flex gap-2 mt-3">
                <input value={serverUrl} onChange={e => setServerUrl(e.target.value)} className="input flex-1 min-w-0" autoFocus
                  placeholder="anki.example.com" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <button className="btn btn-primary" type="submit">Use</button>
              </form>
            ) : (
              <button onClick={() => { setServerUrl(app?.server ?? ''); setEditingServer(true); }}
                className="inline-flex items-center gap-1.5 text-sm text-(--text-secondary) hover:text-white">
                <Server className="w-3.5 h-3.5" />{serverHost || 'No server'} · <span className="text-(--accent)">change</span>
              </button>
            )}
            {serverError && <p className="text-(--error) text-sm mt-2">{serverError}</p>}
          </div>
        ) : <div className="mb-4" />}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('login.username')}
              className={inputCls}
              autoFocus={!isNative}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="username"
              disabled={isLocked || loading}
              required
            />
          </div>

          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.password')}
              className={`${inputCls} pr-10 password-input`}
              disabled={isLocked || loading}
              required
            />
            {password && !isLocked && (
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
            disabled={loading || isLocked}
            className="btn btn-primary w-full"
          >
            {loading ? t('login.loggingIn') : t('login.loginButton')}
          </button>
        </form>

        {isNative && (
          <div className="mt-6 pt-5 border-t border-(--bg-tertiary) space-y-3">
            <button onClick={() => saveServer(null)} className="btn btn-secondary w-full flex items-center justify-center gap-2">
              <Smartphone className="w-4 h-4" /> Use on this {device} only
            </button>
            <p className="text-xs text-(--text-secondary) text-center leading-relaxed">
              Decks, studying, stats and sync with AnkiWeb (or your own sync server) all work without a server.
              Stories, AI and Quizlet need one; you can add it later in Settings.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
