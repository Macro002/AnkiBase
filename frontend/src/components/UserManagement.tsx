import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Crown, KeyRound, Layers, Plus, Shield, Trash2, UserRound, X } from 'lucide-react';
import { users as usersApi, type AnkiAccount, type UserFlags, type UserInfo } from '../api';
import { Segmented, Toggle } from './quizlet/ui';

type Flag = Exclude<keyof UserFlags, 'is_admin'>;

/** The permissions an admin can give a member (admins have all of them). */
const PERMISSIONS: { flag: Flag; key: string }[] = [
  { flag: 'can_import', key: 'import' },
  { flag: 'can_use_ai', key: 'useAi' },
  { flag: 'can_add_containers', key: 'manageProfiles' },
  { flag: 'can_manage_ai_keys', key: 'manageAiKeys' },
  { flag: 'can_edit_server_accent', key: 'serverTheme' },
];

const DEFAULT_FLAGS: UserFlags = {
  is_admin: false, can_import: true, can_use_ai: true, can_add_containers: false,
  can_manage_ai_keys: false, can_edit_server_accent: false,
};

interface Draft extends UserFlags {
  username: string;
  password: string;
  container_ids: number[];
}

/** Role, permissions and profiles: the same form for a new user and an existing one. */
function UserForm({ draft, onChange, profiles, isNew, locked }: {
  draft: Draft; onChange: (d: Draft) => void; profiles: AnkiAccount[]; isNew: boolean; locked: boolean;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const toggleProfile = (id: number) =>
    set({ container_ids: draft.container_ids.includes(id) ? draft.container_ids.filter(x => x !== id) : [...draft.container_ids, id] });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-(--text-secondary)">{t('users.username')}</span>
          <input className="input w-full" value={draft.username} onChange={e => set({ username: e.target.value })}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={locked} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-(--text-secondary)">{isNew ? t('users.password') : t('users.newPassword')}</span>
          <input className="input w-full" type="password" value={draft.password} onChange={e => set({ password: e.target.value })}
            placeholder={isNew ? t('users.passwordHint') : t('users.keepPassword')} autoComplete="new-password" disabled={locked} />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-(--text-secondary)">{t('users.role')}</p>
        <Segmented size="md" value={draft.is_admin ? 'admin' : 'member'} onChange={v => set({ is_admin: v === 'admin' })}
          options={[{ value: 'member', label: t('users.member'), icon: <UserRound className="w-4 h-4" /> },
                    { value: 'admin', label: t('users.admin'), icon: <Shield className="w-4 h-4" /> }]} />
        <p className="text-xs text-(--text-secondary)">{draft.is_admin ? t('users.adminHint') : t('users.memberHint')}</p>
      </div>

      {!draft.is_admin && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wider text-(--text-secondary) mb-1">{t('users.permissions')}</p>
          {PERMISSIONS.map(({ flag, key }) => (
            <div key={flag} className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 bg-(--bg-tertiary)/40">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t(`users.perm.${key}`)}</p>
                <p className="text-xs text-(--text-secondary)">{t(`users.perm.${key}Hint`)}</p>
              </div>
              <Toggle on={draft[flag]} onChange={v => set({ [flag]: v } as Partial<Draft>)} />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-(--text-secondary)">{t('users.profiles')}</p>
        {draft.is_admin ? (
          <p className="text-sm text-(--text-secondary)">{t('users.allProfiles')}</p>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-(--text-secondary)">{t('users.noProfiles')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profiles.map(p => {
              const on = draft.container_ids.includes(p.id);
              return (
                <button key={p.id} type="button" onClick={() => toggleProfile(p.id)}
                  className={`flex items-center gap-1.5 px-3 h-9 rounded-full text-sm border transition-colors ${
                    on ? 'bg-(--accent)/15 border-(--accent) text-(--text-primary)' : 'border-(--bg-tertiary) text-(--text-secondary) hover:text-(--text-primary)'}`}>
                  {on ? <Check className="w-3.5 h-3.5" /> : <Layers className="w-3.5 h-3.5" />}{p.container_name}
                </button>
              );
            })}
          </div>
        )}
        {!draft.is_admin && profiles.length > 0 && draft.container_ids.length === 0 && (
          <p className="text-xs text-(--warning)">{t('users.noProfileWarning')}</p>
        )}
      </div>
    </div>
  );
}

function summary(u: UserInfo, profiles: AnkiAccount[], t: (k: string) => string): string[] {
  if (u.is_admin) return [t('users.everything')];
  const items = PERMISSIONS.filter(p => u[p.flag]).map(p => t(`users.perm.${p.key}`));
  const names = profiles.filter(p => u.container_ids.includes(p.id)).map(p => p.container_name);
  return [...items, names.length ? `${t('users.profiles')}: ${names.join(', ')}` : t('users.noProfileShort')];
}

export function UserManagement() {
  const { t } = useTranslation();
  const [list, setList] = useState<UserInfo[]>([]);
  const [profiles, setProfiles] = useState<AnkiAccount[]>([]);
  const [open, setOpen] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<UserInfo | null>(null);
  const [me, setMe] = useState<string>('');

  const load = async () => {
    try {
      const data = await usersApi.list();
      setList(data.users);
      setProfiles(data.profiles);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load users'); }
  };
  useEffect(() => {
    load();
    fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json()).then(u => setMe(u.username)).catch(() => {});
  }, []);

  const edit = (u: UserInfo) => {
    setError('');
    if (open === u.id) { setOpen(null); return; }
    setOpen(u.id);
    setDraft({ ...u, password: '', container_ids: [...u.container_ids] });
  };
  const add = () => {
    setError('');
    setOpen('new');
    setDraft({ ...DEFAULT_FLAGS, username: '', password: '', container_ids: profiles.length === 1 ? [profiles[0].id] : [] });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setError('');
    const flags: Partial<UserFlags> = {
      is_admin: draft.is_admin, can_import: draft.can_import, can_use_ai: draft.can_use_ai,
      can_add_containers: draft.can_add_containers, can_manage_ai_keys: draft.can_manage_ai_keys,
      can_edit_server_accent: draft.can_edit_server_accent,
    };
    try {
      if (open === 'new') {
        await usersApi.create({ ...flags, username: draft.username.trim(), password: draft.password, container_ids: draft.container_ids });
      } else if (typeof open === 'number') {
        const before = list.find(u => u.id === open)!;
        await usersApi.update(open, {
          ...flags,
          username: draft.username.trim() !== before.username ? draft.username.trim() : undefined,
          password: draft.password || undefined,
        });
        await usersApi.setProfiles(open, draft.container_ids);
      }
      setOpen(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally { setSaving(false); }
  };

  const remove = async (u: UserInfo) => {
    setConfirmDelete(null);
    try { await usersApi.delete(u.id); setOpen(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete'); }
  };

  const footer = (u?: UserInfo) => (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button onClick={save} disabled={saving || !draft?.username.trim() || (open === 'new' && (draft?.password.length ?? 0) < 8)}
        className="btn btn-primary">{saving ? t('users.saving') : open === 'new' ? t('users.create') : t('users.save')}</button>
      <button onClick={() => setOpen(null)} className="btn btn-secondary">{t('common.cancel')}</button>
      {u && !u.is_owner && u.username !== me && (
        <button onClick={() => setConfirmDelete(u)} className="btn btn-secondary ml-auto flex items-center gap-2 hover:!bg-red-500/20 hover:!text-red-400">
          <Trash2 className="w-4 h-4" /> {t('users.delete')}
        </button>
      )}
    </div>
  );

  return (
    <section className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{t('users.title')}</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">{t('users.subtitle')}</p>
        </div>
        {open !== 'new' && <button onClick={add} className="btn btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> {t('users.add')}</button>}
      </div>

      {error && <p className="text-sm text-(--error) anim-rise">{error}</p>}

      {open === 'new' && draft && (
        <div className="card space-y-4 anim-rise border border-(--accent)/40">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold">{t('users.newUser')}</h4>
            <button onClick={() => setOpen(null)} className="icon-btn"><X className="w-4 h-4" /></button>
          </div>
          <UserForm draft={draft} onChange={setDraft} profiles={profiles} isNew locked={false} />
          {footer()}
        </div>
      )}

      {list.map(u => {
        const expanded = open === u.id && draft;
        const lockedOwner = u.is_owner && u.username !== me;
        return (
          <div key={u.id} className={`card !p-0 overflow-hidden border ${expanded ? 'border-(--accent)/40' : 'border-transparent'}`}>
            <button onClick={() => edit(u)} className="w-full flex items-center gap-3 p-4 text-left">
              <span className="w-10 h-10 rounded-full bg-(--accent)/15 text-(--accent) flex items-center justify-center font-bold uppercase shrink-0">
                {u.username[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium truncate">{u.username}</span>
                  {u.is_owner && <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 flex items-center gap-1"><Crown className="w-3 h-3" />{t('users.owner')}</span>}
                  {u.is_admin && !u.is_owner && <span className="text-[11px] px-2 py-0.5 rounded-full bg-(--accent)/15 text-(--accent) flex items-center gap-1"><Shield className="w-3 h-3" />{t('users.admin')}</span>}
                  {u.username === me && <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-(--text-secondary)">{t('users.you')}</span>}
                </span>
                <span className="block text-xs text-(--text-secondary) truncate mt-0.5">{summary(u, profiles, t).join(' · ')}</span>
              </span>
              <ChevronDown className={`w-4 h-4 text-(--text-secondary) transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
            {expanded && (
              <div className="px-4 pb-4 space-y-4 anim-rise">
                {lockedOwner ? (
                  <p className="text-sm text-(--text-secondary) flex items-center gap-2"><KeyRound className="w-4 h-4" />{t('users.ownerLocked')}</p>
                ) : (
                  <>
                    <UserForm draft={draft} onChange={setDraft} profiles={profiles} isNew={false} locked={false} />
                    {footer(u)}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      {confirmDelete && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={() => setConfirmDelete(null)}>
          <div className="card max-w-sm w-full space-y-4" onClick={e => e.stopPropagation()}>
            <h4 className="font-semibold">{t('users.deleteTitle', { name: confirmDelete.username })}</h4>
            <p className="text-sm text-(--text-secondary)">{t('users.deleteText')}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="btn btn-secondary">{t('common.cancel')}</button>
              <button onClick={() => remove(confirmDelete)} className="btn btn-error">{t('users.delete')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
