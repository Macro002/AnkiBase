import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, Download, Eye, EyeOff, LogOut, RefreshCw, Server, Upload } from 'lucide-react';
import { ankiweb, sync, syncServer, type AnkiWebStatus, type MediaSyncStatus } from '../../api';
import { SyncServerCard } from './SyncServerCard';
import { Segmented, Toggle } from '../quizlet/ui';
import { device, isNative } from '../../native';
import { autoSyncEnabled, forgetSyncLogin, runSync, setAutoSync, useSyncState, type SyncResult } from '../../sync';

type Target = 'ankiweb' | 'own';

/** `when`: Unix seconds (the app), milliseconds or an ISO date (the server's engine). */
function ago(when: number | string | null | undefined): string {
  if (!when) return 'never';
  const ms = typeof when === 'string' ? Date.parse(when) : when > 1e12 ? when : when * 1000;
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = ms / 1000;
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function hostOf(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Settings → Sync: where the collection syncs to (AnkiWeb or your own sync server), the
 *  login, and syncing by hand. */
export function SyncSection({ admin = false }: { admin?: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AnkiWebStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [target, setTarget] = useState<Target>('ankiweb');
  const [endpoint, setEndpoint] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<'' | 'login' | 'logout' | 'upload' | 'download'>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<'' | 'upload' | 'download'>('');
  const [auto, setAuto] = useState(autoSyncEnabled());
  const [media, setMedia] = useState<MediaSyncStatus | null>(null);
  const syncing = useSyncState() === 'syncing';
  // This AnkiBase's own sync server, if it runs one: offered in the login form.
  const [ownServer, setOwnServer] = useState<string | null>(null);
  useEffect(() => { syncServer.status().then(s => setOwnServer(s.running ? s.url : null)).catch(() => {}); }, []);

  const useServer = (url: string, name: string) => {
    if (status?.configured) { setMessage(`Log out first, then log in to ${hostOf(url)} as ${name}.`); return; }
    setTarget('own'); setEndpoint(url); setEmail(name); setPassword(''); setError('');
    setMessage(`Enter ${name}’s password to sync this collection with your sync server.`);
  };
  const request = useRef(0);

  const load = async () => {
    const id = ++request.current;
    try {
      const s = await ankiweb.status();
      if (id !== request.current) return;
      setStatus(s);
      setLoadError('');
      forgetSyncLogin(s.configured);
      if (s.endpoint) { setTarget('own'); setEndpoint(s.endpoint); }
    } catch (err) {
      if (id === request.current) setLoadError(err instanceof Error ? err.message : 'Could not load the sync status');
    }
  };

  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener('anki-sync-complete', refresh);
    return () => window.removeEventListener('anki-sync-complete', refresh);
  }, []);

  // The app: media keeps syncing after the collection; show it until it's done.
  useEffect(() => {
    if (!isNative || !status?.configured) return;
    let stop = false;
    const poll = async () => {
      try {
        const m = await sync.media();
        if (stop) return;
        setMedia(m);
        if (m.active) setTimeout(poll, 1500);
      } catch { /* not this time */ }
    };
    poll();
    const again = () => setTimeout(poll, 500);
    window.addEventListener('anki-sync-complete', again);
    return () => { stop = true; window.removeEventListener('anki-sync-complete', again); };
  }, [status?.configured]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMessage('');
    if (target === 'own' && !endpoint.trim()) { setError('Enter your sync server’s address.'); return; }
    setBusy('login');
    try {
      await ankiweb.login(email.trim(), password, target === 'own' ? endpoint.trim() : null);
      setPassword('');
      await load();
      setMessage('Logged in. Sync to bring your collection over.');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ankiweb.loginFailed'));
    } finally { setBusy(''); }
  };

  const logout = async () => {
    setBusy('logout'); setError(''); setMessage('');
    try {
      await ankiweb.deleteCredentials();
      await load();
      setTarget('ankiweb');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ankiweb.logoutFailed'));
    } finally { setBusy(''); }
  };

  const syncNow = async () => {
    setError(''); setMessage('');
    const result: SyncResult = await runSync({ quiet: true });
    if (result.kind === 'done') {
      setMessage(result.outcome === 'fullDownload' ? 'Downloaded your collection.'
        : result.outcome === 'fullUpload' ? 'Uploaded your collection.' : 'Everything is up to date.');
    } else if (result.kind === 'error') setError(result.message);
    else if (result.kind === 'not-configured') setError('Log in first.');
    await load();
  };

  const fullSync = async (direction: 'upload' | 'download') => {
    setConfirm(''); setBusy(direction); setError(''); setMessage('');
    try {
      if (direction === 'upload') await sync.fullUpload(); else await sync.fullDownload();
      window.dispatchEvent(new CustomEvent('anki-sync-complete'));
      setMessage(direction === 'upload' ? 'Uploaded: the server now has this collection.' : 'Downloaded: this collection now matches the server.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally { setBusy(''); }
  };

  const where = status?.endpoint ? hostOf(status.endpoint) : 'AnkiWeb';

  return (
    <>
      <section className="card space-y-4">
        <div>
          <h3 className="font-semibold">Sync</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">
            {isNative
              ? `Your collection lives on this ${device}. Syncing keeps it in step with Anki on your other devices.`
              : 'Keeps this collection in step with Anki on your other devices.'}
          </p>
        </div>

        {loadError && <p className="text-sm text-(--error)">{loadError}</p>}
        {!status && !loadError && <div className="skeleton h-24 rounded-xl" />}

        {status?.configured && (
          <div className="space-y-4">
            <div className="rounded-xl bg-(--bg-tertiary)/60 p-4 flex items-start gap-3">
              <span className="w-10 h-10 rounded-full bg-(--accent)/15 text-(--accent) flex items-center justify-center shrink-0">
                {status.endpoint ? <Server className="w-5 h-5" /> : <Cloud className="w-5 h-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{status.email}</p>
                <p className="text-xs text-(--text-secondary) truncate">
                  {status.endpoint ? <>Your sync server · {where}</> : 'AnkiWeb'} · last sync {ago(status.last_sync)}
                </p>
                {media && (media.active || media.error) && (
                  <p className={`text-xs mt-1 ${media.error ? 'text-(--error)' : 'text-(--text-secondary)'}`}>
                    {media.error ? `Media: ${media.error}` : 'Syncing images and audio…'}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={syncNow} disabled={syncing || !!busy} className="btn btn-primary flex items-center gap-2">
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Syncing…' : 'Sync now'}
              </button>
              <button onClick={logout} disabled={syncing || !!busy} className="btn btn-secondary flex items-center gap-2">
                <LogOut className="w-4 h-4" /> {busy === 'logout' ? 'Logging out…' : 'Log out'}
              </button>
            </div>
          </div>
        )}

        {status && !status.configured && (
          <form onSubmit={login} className="space-y-3 max-w-md">
            <Segmented size="md" value={target} onChange={v => { setTarget(v); setError(''); }}
              options={[{ value: 'ankiweb', label: 'AnkiWeb', icon: <Cloud className="w-4 h-4" /> },
                        { value: 'own', label: 'Own sync server', icon: <Server className="w-4 h-4" /> }]} />
            {target === 'own' && ownServer && endpoint !== ownServer && (
              <button type="button" onClick={() => setEndpoint(ownServer)}
                className="w-full text-left rounded-xl border border-(--accent)/40 bg-(--accent)/10 px-3 py-2.5 text-sm">
                Use this AnkiBase’s sync server <span className="text-(--text-secondary)">· {hostOf(ownServer)}</span>
              </button>
            )}
            {target === 'own' && (
              <div className="space-y-1.5">
                <input value={endpoint} onChange={e => setEndpoint(e.target.value)} className="input w-full"
                  placeholder="https://sync.example.com/" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  aria-label="Sync server address" />
                <p className="text-xs text-(--text-secondary) leading-relaxed">
                  Anki’s own sync server (<code>python -m anki.syncserver</code> or <code>anki-sync-server</code>) —
                  the same address you’d enter in Anki’s Preferences → Syncing.
                </p>
              </div>
            )}
            <input type="text" value={email} onChange={e => setEmail(e.target.value)} className="input w-full" required
              placeholder={target === 'own' ? 'Username' : t('ankiweb.emailPlaceholder')} autoComplete="username"
              autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Username" />
            <div className="relative">
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                className="input w-full pr-10 password-input" required placeholder={t('ankiweb.password')} autoComplete="current-password"
                aria-label={t('ankiweb.password')} />
              {password && (
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label="Show password"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-(--text-secondary) hover:text-white">
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              )}
            </div>
            <button type="submit" disabled={busy === 'login'} className="btn btn-primary w-full sm:w-auto">
              {busy === 'login' ? t('ankiweb.loggingIn') : 'Log in'}
            </button>
            {target === 'ankiweb' && (
              <p className="text-xs text-(--text-secondary)">
                No account? <a href="https://ankiweb.net/account/signup" target="_blank" rel="noreferrer" className="text-(--accent)">Sign up at AnkiWeb</a> ·{' '}
                <a href="https://ankiweb.net/account/reset-password" target="_blank" rel="noreferrer" className="text-(--accent)">{t('ankiweb.forgotPassword')}</a>
              </p>
            )}
          </form>
        )}

        {error && <p className="text-sm text-(--error) anim-rise">{error}</p>}
        {message && <p className="text-sm text-green-400 anim-rise">{message}</p>}
      </section>

      {admin && <SyncServerCard onUse={useServer} />}

      {isNative && (
        <section className="card">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="font-semibold">Sync automatically</h3>
              <p className="text-xs text-(--text-secondary) mt-0.5">When the app opens and when you leave it, like Anki on phones.</p>
            </div>
            <Toggle on={auto} onChange={v => { setAuto(v); setAutoSync(v); }} />
          </div>
        </section>
      )}

      {status?.configured && (
        <section className="card space-y-3">
          <div>
            <h3 className="font-semibold">One-way sync</h3>
            <p className="text-xs text-(--text-secondary) mt-0.5">
              When this collection and the server’s can’t be merged, pick the one to keep. The other is replaced.
            </p>
          </div>
          {confirm ? (
            <div className="rounded-xl border border-orange-400/40 bg-orange-400/10 p-4 space-y-3 anim-rise">
              <p className="text-sm">
                {confirm === 'upload'
                  ? <>Replace the collection on {where} with this one? Changes made on other devices since their last sync are lost.</>
                  : <>Replace this collection with the one on {where}? Reviews and edits here that weren’t synced are lost.</>}
              </p>
              <div className="flex gap-2">
                <button onClick={() => fullSync(confirm)} className="btn btn-warning">{confirm === 'upload' ? 'Upload' : 'Download'}</button>
                <button onClick={() => setConfirm('')} className="btn btn-secondary">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setConfirm('upload')} disabled={!!busy || syncing} className="btn btn-secondary flex items-center gap-2">
                <Upload className="w-4 h-4" /> {busy === 'upload' ? 'Uploading…' : `Upload to ${where}`}
              </button>
              <button onClick={() => setConfirm('download')} disabled={!!busy || syncing} className="btn btn-secondary flex items-center gap-2">
                <Download className="w-4 h-4" /> {busy === 'download' ? 'Downloading…' : `Download from ${where}`}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
