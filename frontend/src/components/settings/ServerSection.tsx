import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpCircle, CheckCircle2, CloudOff, LogIn, LogOut, Server, Smartphone } from 'lucide-react';
import { auth, update as updateApi, type User } from '../../api';
import { appStatus, useAppStatus } from '../../native';
import { UpdateModal } from '../UpdateModal';

interface AppUpdate {
  current: { version: string; build: string };
  latest: { version: string; build: string; notes?: string | null; date?: string | null } | null;
  has_update: boolean;
  source?: string;
}

/** Settings → Server (the app): the AnkiBase server for stories, AI and Quizlet, the
 *  app's version, and updates. */
export function ServerSection({ user }: { user: User | null }) {
  const app = useAppStatus();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdate | null>(null);
  const [serverUpdate, setServerUpdate] = useState<{ current: string; latest: string; has_update: boolean } | null>(null);
  const [showServerUpdate, setShowServerUpdate] = useState(false);

  useEffect(() => {
    fetch('/api/app/update').then(r => r.json()).then(setAppUpdate).catch(() => {});
  }, []);
  useEffect(() => {
    if (app?.server && app.server_login && user?.is_admin) updateApi.check().then(setServerUpdate).catch(() => {});
  }, [app?.server, app?.server_login, user?.is_admin]);

  const save = async (next: string | null) => {
    setError(''); setBusy(true);
    try {
      const status = await appStatus.setServer(next);
      setEditing(false);
      if (status.server && !status.online) setError(`Couldn't reach ${status.server}. It's saved; the app tries again when you're online.`);
      else if (status.server) navigate('/login');
      else window.location.replace('/settings?tab=server');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the server');
    } finally { setBusy(false); }
  };

  const signOut = async () => {
    await auth.logout().catch(() => {});
    window.location.replace('/login');
  };

  if (!app) return <div className="card skeleton h-40" />;
  const host = app.server?.replace(/^https?:\/\//, '');
  const signedIn = app.server && app.server_login;

  return (
    <>
      <section className="card space-y-4">
        <div>
          <h3 className="font-semibold">AnkiBase server</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">
            Stories, AI, Quizlet sets and the dictionary come from your server. Everything else runs on this iPhone.
          </p>
        </div>

        <div className="rounded-xl bg-(--bg-tertiary)/60 p-4 flex items-start gap-3">
          <span className="w-10 h-10 rounded-full bg-(--accent)/15 text-(--accent) flex items-center justify-center shrink-0">
            {app.server ? (app.online ? <Server className="w-5 h-5" /> : <CloudOff className="w-5 h-5" />) : <Smartphone className="w-5 h-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium truncate">{host ?? 'No server: this iPhone only'}</p>
            <p className="text-xs text-(--text-secondary)">
              {!app.server ? 'Your decks, studying, stats and sync work without one.'
                : !app.online ? 'Offline. What you opened before still works; changes are sent when it’s back.'
                : signedIn ? <>Signed in{user ? <> as <span className="text-white">{user.username}</span></> : null}</>
                : 'Not signed in'}
            </p>
            {app.pending > 0 && (
              <p className="text-xs text-(--warning) mt-1">{app.pending} change{app.pending === 1 ? '' : 's'} waiting to be sent</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {app.server && !signedIn && app.online && (
            <button onClick={() => navigate('/login')} className="btn btn-primary flex items-center gap-2"><LogIn className="w-4 h-4" /> Sign in</button>
          )}
          {signedIn && (
            <button onClick={signOut} className="btn btn-secondary flex items-center gap-2"><LogOut className="w-4 h-4" /> Sign out</button>
          )}
          {!app.online && app.server && (
            <button onClick={() => appStatus.check()} className="btn btn-secondary">Try again</button>
          )}
          {!editing && (
            <button onClick={() => { setUrl(app.server ?? app.default_server ?? ''); setEditing(true); setError(''); }} className="btn btn-secondary">
              {app.server ? 'Change server' : 'Connect a server'}
            </button>
          )}
        </div>

        {editing && (
          <form onSubmit={e => { e.preventDefault(); save(url); }} className="space-y-3 anim-rise max-w-md">
            <input value={url} onChange={e => setUrl(e.target.value)} className="input w-full" placeholder="anki.example.com" autoFocus
              inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Server address" />
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={busy || !url.trim()} className="btn btn-primary">{busy ? 'Connecting…' : 'Connect'}</button>
              <button type="button" onClick={() => setEditing(false)} className="btn btn-secondary">Cancel</button>
              {app.server && (
                <button type="button" onClick={() => save(null)} disabled={busy} className="btn btn-secondary flex items-center gap-2">
                  <Smartphone className="w-4 h-4" /> Use without a server
                </button>
              )}
            </div>
            <p className="text-xs text-(--text-secondary)">Switching servers signs you out and forgets what was saved from the old one.</p>
          </form>
        )}
        {error && <p className="text-sm text-(--error) anim-rise">{error}</p>}

        {serverUpdate?.has_update && (
          <div className="rounded-xl border border-(--accent)/40 bg-(--accent)/10 p-4 flex flex-wrap items-center gap-3">
            <ArrowUpCircle className="w-5 h-5 text-(--accent)" />
            <p className="text-sm flex-1 min-w-0 break-words">A server update is available
              <span className="block text-xs text-(--text-secondary) font-mono">{serverUpdate.current.slice(0, 7)} → {serverUpdate.latest.slice(0, 7)}</span></p>
            <button onClick={() => setShowServerUpdate(true)} className="btn btn-primary">Update server</button>
          </div>
        )}
      </section>

      <section className="card space-y-3">
        <div>
          <h3 className="font-semibold">App</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">AnkiBase {app.version} (build {app.build}) with Anki’s own engine.</p>
        </div>
        {appUpdate?.has_update && appUpdate.latest ? (
          <div className="rounded-xl border border-(--accent)/40 bg-(--accent)/10 p-4 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2"><ArrowUpCircle className="w-4 h-4 text-(--accent)" />
              Build {appUpdate.latest.build} is out</p>
            {appUpdate.latest.notes && <p className="text-xs text-(--text-secondary) whitespace-pre-line">{appUpdate.latest.notes}</p>}
            <a href="sidestore://" className="btn btn-primary inline-block">Open SideStore</a>
          </div>
        ) : appUpdate?.latest ? (
          <p className="text-sm text-(--text-secondary) flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-400" /> Up to date</p>
        ) : null}
        {app.collection_error && <p className="text-sm text-(--error)">Collection: {app.collection_error}</p>}
      </section>

      <UpdateModal isOpen={showServerUpdate} onClose={() => setShowServerUpdate(false)} />
    </>
  );
}
