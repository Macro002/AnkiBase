import { useEffect, useState } from 'react';
import { Check, Copy, HardDrive, Play, Plus, Square, Trash2, UserPlus } from 'lucide-react';
import { syncServer, type SyncServerStatus } from '../../api';

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Settings → Sync (admins): run Anki's own sync server on this AnkiBase, so Anki on every
 *  device can sync here instead of AnkiWeb. `onUse` fills in the login form with it. */
export function SyncServerCard({ onUse }: { onUse?: (url: string, name: string) => void }) {
  const [status, setStatus] = useState<SyncServerStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => { syncServer.status().then(setStatus).catch(e => setError(e.message)); }, []);

  const run = async (label: string, action: () => Promise<SyncServerStatus>): Promise<SyncServerStatus | null> => {
    setBusy(label); setError('');
    try { const next = await action(); setStatus(prev => ({ ...next, url: next.url ?? prev?.url })); return next; }
    catch (e) { setError(e instanceof Error ? e.message : 'That didn’t work'); return null; }
    finally { setBusy(''); }
  };

  const addAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const account = name.trim();
    const added = await run('add', () => syncServer.addAccount(account, password));
    if (!added) return;
    // The first account is all it takes: start the server right away.
    if (!added.running && !(await run('start', syncServer.start))?.running) return;
    if (status) onUse?.(status.url, account);
    setName(''); setPassword(''); setAdding(false);
  };

  const copy = async () => {
    if (!status) return;
    try { await navigator.clipboard.writeText(status.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };

  if (!status) return error ? <section className="card text-sm text-(--error)">{error}</section> : null;
  const list = status.accounts ?? [];

  return (
    <section className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><HardDrive className="w-4 h-4 text-(--accent)" /> Sync server on this AnkiBase</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5 leading-relaxed">
            Anki’s own sync server, run right here. Anki Desktop, AnkiMobile, AnkiDroid and the AnkiBase app can all sync with it
            instead of AnkiWeb — your collection never leaves your server.
          </p>
        </div>
        <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${status.running ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-(--text-secondary)'}`}>
          {status.running ? 'Running' : status.enabled ? 'Stopped' : 'Off'}
        </span>
      </div>

      {(status.running || list.length > 0) && (
        <div className="rounded-xl bg-(--bg-tertiary)/60 p-3 space-y-1">
          <p className="text-[11px] uppercase tracking-wider text-(--text-secondary)">Address for Anki</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-sm">{status.url}</code>
            <button onClick={copy} className="icon-btn" title="Copy">{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}</button>
          </div>
          <p className="text-xs text-(--text-secondary)">Anki Desktop: Preferences → Syncing → Self-hosted sync server. AnkiDroid: Settings → Advanced → Custom sync server.</p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">Accounts</p>
        {list.length === 0 && <p className="text-sm text-(--text-secondary)">No accounts yet. Each account has its own collection on the server.</p>}
        {list.map(a => (
          <div key={a.name} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-(--bg-tertiary)/40">
            <span className="flex-1 min-w-0 truncate text-sm">{a.name}</span>
            <span className="text-xs text-(--text-secondary)">{a.size ? size(a.size) : 'empty'}</span>
            {onUse && status.running && (
              <button onClick={() => onUse(status.url, a.name)} className="text-xs text-(--accent)">Use here</button>
            )}
            <button onClick={() => setRemoving(a.name)} className="icon-btn icon-btn-danger" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
        {removing && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 space-y-2 anim-rise">
            <p className="text-sm">Remove <b>{removing}</b>? Anki on their devices can’t sync here any more.</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => { const n = removing; setRemoving(null); run('remove', () => syncServer.removeAccount(n, false)); }} className="btn btn-secondary">Keep their collection</button>
              <button onClick={() => { const n = removing; setRemoving(null); run('remove', () => syncServer.removeAccount(n, true)); }} className="btn btn-error">Delete it too</button>
              <button onClick={() => setRemoving(null)} className="btn btn-secondary">Cancel</button>
            </div>
          </div>
        )}
        {adding ? (
          <form onSubmit={addAccount} className="space-y-2 max-w-md anim-rise">
            <input value={name} onChange={e => setName(e.target.value)} className="input w-full" placeholder="Username (e.g. your email)" required
              autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Sync account name" />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="input w-full" placeholder="Password (6+ characters)"
              required minLength={6} autoComplete="new-password" aria-label="Sync account password" />
            <div className="flex gap-2">
              <button type="submit" disabled={!!busy} className="btn btn-primary">{busy ? 'Setting up…' : list.length ? 'Add account' : 'Add & start the server'}</button>
              <button type="button" onClick={() => setAdding(false)} className="btn btn-secondary">Cancel</button>
            </div>
          </form>
        ) : (
          <button onClick={() => setAdding(true)} className="btn btn-secondary flex items-center gap-2">
            {list.length ? <Plus className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />} {list.length ? 'Add account' : 'Set up: add the first account'}
          </button>
        )}
      </div>

      {list.length > 0 && (
        <div className="flex gap-2">
          {status.running ? (
            <button onClick={() => run('stop', syncServer.stop)} disabled={!!busy} className="btn btn-secondary flex items-center gap-2">
              <Square className="w-4 h-4" /> {busy === 'stop' ? 'Stopping…' : 'Stop server'}
            </button>
          ) : (
            <button onClick={() => run('start', syncServer.start)} disabled={!!busy} className="btn btn-primary flex items-center gap-2">
              <Play className="w-4 h-4" /> {busy === 'start' ? 'Starting…' : 'Start server'}
            </button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-(--error) anim-rise">{error}</p>}
    </section>
  );
}
