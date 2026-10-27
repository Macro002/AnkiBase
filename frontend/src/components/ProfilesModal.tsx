import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Layers, Loader2, Pencil, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { accounts, auth, type AnkiAccount, type User } from '../api';

/** Profiles: separate Anki collections on this server (one per person, or per language).
 *  Which ones a user may use is set by an admin; switching only affects this login. */
export function ProfilesModal({ isOpen, onClose, onSwitch }: { isOpen: boolean; onClose: () => void; onSwitch: () => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<AnkiAccount[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ profile: AnkiAccount; removeData: boolean } | null>(null);

  const canManage = !!user?.permissions?.manage_profiles;

  const load = async () => {
    try {
      const [data, me] = await Promise.all([accounts.list(), auth.me()]);
      setList(data.accounts);
      setActive(data.active_account_id);
      setUser(me);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load profiles'); }
  };

  useEffect(() => {
    if (isOpen) { load(); setAdding(false); setRenaming(null); setDeleting(null); setNotice(''); }
  }, [isOpen]);

  const run = async (label: string, action: () => Promise<unknown>, after?: () => void) => {
    setBusy(label); setError(''); setNotice('');
    try { await action(); await load(); after?.(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That didn’t work'); }
    finally { setBusy(''); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div className="bg-(--bg-secondary) w-full sm:max-w-lg max-h-[85dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-5 space-y-4 anim-rise sheet-safe-bottom"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2"><Layers className="w-5 h-5 text-(--accent)" />{t('profiles.title')}</h2>
            <p className="text-xs text-(--text-secondary) mt-1">{t('profiles.subtitle')}</p>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label={t('common.close')}><X className="w-4 h-4" /></button>
        </div>

        {error && <p className="text-sm text-(--error)">{error}</p>}
        {notice && <p className="text-sm text-green-400">{notice}</p>}

        <div className="space-y-2">
          {list.length === 0 && !busy && <p className="text-sm text-(--text-secondary)">{t('profiles.none')}</p>}
          {list.map(p => {
            const isActive = p.id === active;
            if (renaming?.id === p.id) {
              return (
                <form key={p.id} className="flex gap-2" onSubmit={e => { e.preventDefault(); run('rename', () => accounts.rename(p.id, renaming.name.trim()), () => setRenaming(null)); }}>
                  <input className="input flex-1 min-w-0" value={renaming.name} onChange={e => setRenaming({ ...renaming, name: e.target.value })} autoFocus />
                  <button className="btn btn-primary" disabled={!renaming.name.trim() || !!busy}>{t('profiles.save')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setRenaming(null)}>{t('common.cancel')}</button>
                </form>
              );
            }
            return (
              <div key={p.id} className={`flex items-center gap-3 rounded-xl px-3 py-3 border ${isActive ? 'border-(--accent) bg-(--accent)/10' : 'border-(--bg-tertiary)'}`}>
                <button className="flex-1 min-w-0 flex items-center gap-3 text-left" disabled={isActive || !!busy}
                  onClick={() => run('switch', () => accounts.switch(p.id), onSwitch)}>
                  <span className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isActive ? 'bg-(--accent) text-white' : 'bg-(--bg-tertiary) text-(--text-secondary)'}`}>
                    {isActive ? <Check className="w-4 h-4" /> : p.container_name[0]?.toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium truncate">{p.container_name}</span>
                    <span className="block text-xs text-(--text-secondary) truncate">
                      {isActive ? t('profiles.current') : p.ankiweb_email ? t('profiles.syncsAs', { email: p.ankiweb_email }) : t('profiles.tapToSwitch')}
                    </span>
                  </span>
                </button>
                <button className="icon-btn" title={t('profiles.reload')} disabled={!!busy}
                  onClick={() => run(`reload-${p.id}`, () => accounts.restart(p.id), () => setNotice(t('profiles.reloaded')))}>
                  <RotateCw className={`w-4 h-4 ${busy === `reload-${p.id}` ? 'animate-spin' : ''}`} />
                </button>
                {canManage && (
                  <>
                    <button className="icon-btn" title={t('profiles.rename')} onClick={() => setRenaming({ id: p.id, name: p.container_name })}><Pencil className="w-4 h-4" /></button>
                    <button className="icon-btn icon-btn-danger" title={t('profiles.delete')} disabled={list.length === 1}
                      onClick={() => setDeleting({ profile: p, removeData: false })}><Trash2 className="w-4 h-4" /></button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {deleting && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 space-y-3 anim-rise">
            <p className="text-sm">{t('profiles.deleteConfirm', { name: deleting.profile.container_name })}</p>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={deleting.removeData} onChange={e => setDeleting({ ...deleting, removeData: e.target.checked })} className="mt-0.5" />
              <span>{t('profiles.deleteData')}<span className="block text-xs text-red-400">{t('profiles.deleteWarning')}</span></span>
            </label>
            <div className="flex gap-2">
              <button className="btn btn-error" disabled={!!busy}
                onClick={() => run('delete', () => accounts.delete(deleting.profile.id, deleting.removeData), () => setDeleting(null))}>{t('profiles.delete')}</button>
              <button className="btn btn-secondary" onClick={() => setDeleting(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {canManage && (adding ? (
          <form className="space-y-2" onSubmit={e => { e.preventDefault(); run('add', () => accounts.create(name.trim()), () => { setAdding(false); setName(''); }); }}>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder={t('profiles.namePlaceholder')} autoFocus />
            <div className="flex gap-2">
              <button className="btn btn-primary flex items-center gap-2" disabled={!name.trim() || !!busy}>
                {busy === 'add' && <Loader2 className="w-4 h-4 animate-spin" />}{t('profiles.create')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>{t('common.cancel')}</button>
            </div>
          </form>
        ) : (
          <button onClick={() => setAdding(true)} className="btn btn-secondary w-full flex items-center justify-center gap-2"><Plus className="w-4 h-4" />{t('profiles.add')}</button>
        ))}
      </div>
    </div>
  );
}
