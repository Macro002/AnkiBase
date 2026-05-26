import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { auth, setup, theme as themeApi } from '../api';

import { Logo } from './Logo';
import { applyAccentColor, saveAccentColor, applyBaseColors, saveBaseColors } from '../hooks/useAccentColor';

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 60;
const SS_UNTIL = 'ankibase-login-lockout';
const SS_COUNT = 'ankibase-login-failcount';

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failCount, setFailCount] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  // Restore lockout / attempt count from sessionStorage on mount
  useEffect(() => {
    const until = Number(sessionStorage.getItem(SS_UNTIL) ?? 0);
    const count = Number(sessionStorage.getItem(SS_COUNT) ?? 0);
    if (until && Date.now() < until) {
      setLockedUntil(until);
      setFailCount(count || MAX_ATTEMPTS);
    } else {
      sessionStorage.removeItem(SS_UNTIL);
      if (count > 0 && count < MAX_ATTEMPTS) {
        setFailCount(count);
        setError(`Wrong username or password — ${count}/${MAX_ATTEMPTS} attempts`);
      } else {
        sessionStorage.removeItem(SS_COUNT);
      }
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
        setFailCount(0);
        setError('');
        sessionStorage.removeItem(SS_UNTIL);
        sessionStorage.removeItem(SS_COUNT);
      } else {
        setError(`Too many attempts. Try again in ${s}s.`);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const lock = (until: number, count: number) => {
    setLockedUntil(until);
    setFailCount(count);
    sessionStorage.setItem(SS_UNTIL, String(until));
    sessionStorage.setItem(SS_COUNT, String(count));
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
      sessionStorage.removeItem(SS_COUNT);
      navigate('/', { replace: true });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('too many')) {
        const match = msg.match(/(\d+)\s*second/i);
        const secs = match ? parseInt(match[1]) : LOCK_SECONDS;
        lock(Date.now() + secs * 1000, MAX_ATTEMPTS);
      } else {
        const next = failCount + 1;
        if (next >= MAX_ATTEMPTS) {
          lock(Date.now() + LOCK_SECONDS * 1000, next);
        } else {
          setFailCount(next);
          sessionStorage.setItem(SS_COUNT, String(next));
          setError(`Wrong username or password — ${next}/${MAX_ATTEMPTS} attempts`);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const inputCls = `input w-full${isLocked ? ' opacity-50 cursor-not-allowed' : ''}`;

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
              className={inputCls}
              autoFocus
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
      </div>
    </div>
  );
}
