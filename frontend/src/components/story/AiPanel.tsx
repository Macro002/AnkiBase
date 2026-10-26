import { useEffect, useState } from 'react';
import { Eye, EyeOff, Pencil, Trash2, Check, Copy, Loader2, ChevronDown } from 'lucide-react';
import { settings, type ProviderInfo } from '../../api';
import { SidePanel } from '../quizlet/ui';

export interface AiChoice { provider: string; model: string }

/**
 * AI settings side panel for the Story tab: which provider/model writes the
 * story, and the API keys behind them.
 */
export function AiPanel({ providers, configured, choice, onChoice, onKeysChanged, onClose }: {
  providers: Record<string, ProviderInfo>;
  configured: Record<string, boolean>;
  choice: AiChoice;
  onChoice: (c: AiChoice) => void;
  onKeysChanged: () => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<Record<string, { id: string; name: string }[]>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [envKeys, setEnvKeys] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadKeys = () => settings.getApiKeys().then(d => { setKeys(d.keys); setEnvKeys(d.is_env_key || {}); }).catch(() => {});
  useEffect(() => { loadKeys(); }, []);

  // Live model list for the chosen provider (falls back to the built-in list).
  useEffect(() => {
    const p = choice.provider;
    if (!p || models[p] || !configured[p]) return;
    let cancelled = false;
    settings.getProviderModels(p)
      .then(r => { if (!cancelled) setModels(m => ({ ...m, [p]: r.models })); })
      .catch(() => { if (!cancelled && providers[p]) setModels(m => ({ ...m, [p]: providers[p].models })); });
    return () => { cancelled = true; };
  }, [choice.provider, configured, providers, models]);

  const saveKey = async (p: string) => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await settings.setApiKey(p, draft.trim());
      await loadKeys();
      onKeysChanged();
      setEditing(null);
      setDraft('');
      if (!choice.provider) onChoice({ provider: p, model: providers[p]?.default_model ?? '' });
    } finally { setBusy(false); }
  };

  const deleteKey = async (p: string) => {
    setBusy(true);
    try {
      await settings.deleteApiKey(p);
      await loadKeys();
      onKeysChanged();
      setConfirmDelete(null);
      if (choice.provider === p) onChoice({ provider: '', model: '' });
    } finally { setBusy(false); }
  };

  const ready = Object.entries(providers).filter(([id]) => configured[id]);
  const modelList = models[choice.provider] ?? providers[choice.provider]?.models ?? [];

  return (
    <SidePanel title="AI settings" onClose={onClose}>
      <div className="p-6 space-y-4">
        <div>
          <p className="font-medium text-sm">Writer</p>
          <p className="text-xs text-(--text-secondary) mt-0.5">The AI that writes your stories.</p>
        </div>
        {ready.length === 0 ? (
          <p className="text-sm text-(--text-secondary)">Add an API key below to start writing stories.</p>
        ) : (
          <div className="space-y-2">
            <Select value={choice.provider} onChange={p => onChoice({ provider: p, model: providers[p]?.default_model ?? '' })}
              options={ready.map(([id, info]) => ({ value: id, label: info.name }))} />
            <Select value={choice.model} onChange={m => onChoice({ ...choice, model: m })}
              options={[...(modelList.some(m => m.id === choice.model) || !choice.model ? [] : [{ id: choice.model, name: choice.model }]), ...modelList]
                .map(m => ({ value: m.id, label: m.name }))} placeholder="Default model" />
          </div>
        )}
      </div>

      <div className="p-6 space-y-3">
        <div>
          <p className="font-medium text-sm">API keys</p>
          <p className="text-xs text-(--text-secondary) mt-0.5">Stored on your server. Keys from the .env file can’t be removed here.</p>
        </div>
        {Object.entries(providers).map(([id, info]) => (
          <div key={id} className="rounded-xl bg-(--bg-tertiary)/60 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm flex-1">{info.name}</span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${configured[id] ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-(--text-secondary)'}`}>
                {configured[id] ? (envKeys[id] ? 'from .env' : 'Connected') : 'Not set'}
              </span>
              {editing !== id && (
                <button className="icon-btn" title={configured[id] ? 'Change key' : 'Add key'}
                  onClick={async () => {
                    setEditing(id); setReveal(false); setDraft('');
                    if (configured[id]) settings.getFullApiKey(id).then(r => setDraft(r.api_key || '')).catch(() => {});
                  }}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              {configured[id] && !envKeys[id] && editing !== id && (
                <button className="icon-btn icon-btn-danger" title="Remove key" onClick={() => setConfirmDelete(id)}><Trash2 className="w-3.5 h-3.5" /></button>
              )}
            </div>
            {keys[id] && editing !== id && (
              <button className="text-xs text-(--text-secondary) hover:text-white font-mono inline-flex items-center gap-1.5"
                title="Copy the full key"
                onClick={async () => {
                  try { const r = await settings.getFullApiKey(id); await navigator.clipboard.writeText(r.api_key); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard unavailable */ }
                }}>
                {keys[id]} {copied === id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 opacity-60" />}
              </button>
            )}
            {editing === id && (
              <form className="space-y-2" onSubmit={e => { e.preventDefault(); saveKey(id); }}>
                <div className="relative">
                  <input type={reveal ? 'text' : 'password'} value={draft} onChange={e => setDraft(e.target.value)} autoFocus
                    placeholder="Paste API key" className="input w-full !pr-10 text-sm" />
                  <button type="button" onClick={() => setReveal(r => !r)} className="absolute right-3 top-1/2 -translate-y-1/2 text-(--text-secondary) hover:text-white">
                    {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEditing(null)} className="btn btn-secondary flex-1 text-sm">Cancel</button>
                  <button type="submit" disabled={busy || !draft.trim()} className="btn btn-primary flex-1 text-sm inline-flex items-center justify-center gap-2">
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}Save
                  </button>
                </div>
              </form>
            )}
            {confirmDelete === id && (
              <div className="flex items-center gap-2 text-sm">
                <span className="flex-1 text-(--text-secondary)">Remove this key?</span>
                <button onClick={() => setConfirmDelete(null)} className="btn btn-secondary text-xs py-1 px-3">Keep</button>
                <button onClick={() => deleteKey(id)} className="btn btn-error text-xs py-1 px-3">Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </SidePanel>
  );
}

export function Select({ value, onChange, options, placeholder, className = '' }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string; group?: string }[]; placeholder?: string; className?: string;
}) {
  const groups = [...new Set(options.map(o => o.group ?? ''))];
  return (
    <div className={`relative ${className}`}>
      <select value={value} onChange={e => onChange(e.target.value)} className="input w-full appearance-none h-10 !py-0 !pl-3 !pr-9 text-sm cursor-pointer">
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {groups.map(g => {
          const items = options.filter(o => (o.group ?? '') === g).map(o => <option key={o.value} value={o.value}>{o.label}</option>);
          return g ? <optgroup key={g} label={g}>{items}</optgroup> : items;
        })}
      </select>
      <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-(--text-secondary)" />
    </div>
  );
}
