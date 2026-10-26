import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2 } from 'lucide-react';
import { decks as decksApi, dictionary, quizlet as quizletApi } from '../api';

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/** "Add as a card" dialog: front/back prefilled, saved to a Quizlet set or an Anki deck (remembers the last one). */
export function AddCardDialog({ prefill, onClose, onAdded }: { prefill: { front: string; back: string }; onClose: () => void; onAdded: (dest: string) => void }) {
  const [front, setFront] = useState(prefill.front);
  const [back, setBack] = useState(prefill.back);
  const [dests, setDests] = useState<{ key: string; label: string; group: string }[] | null>(null);
  const [dest, setDest] = useState<string>(() => store.get('search-add-dest', ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([quizletApi.listDecks().catch(() => ({ decks: [] })), decksApi.list().catch(() => ({ decks: {} as Record<string, number> }))])
      .then(([qz, anki]) => {
        const list = [
          ...qz.decks.map(d => ({ key: `q:${d.id}`, label: d.title, group: 'Quizlet sets' })),
          ...Object.keys(anki.decks).sort().map(n => ({ key: `a:${n}`, label: n.replace(/::/g, ' › '), group: 'Anki decks' })),
        ];
        setDests(list);
        setDest(d => (list.some(x => x.key === d) ? d : list[0]?.key ?? ''));
      });
  }, []);

  const submit = async () => {
    if (!dest || !front.trim() || !back.trim()) return;
    setSaving(true); setError(null);
    try {
      if (dest.startsWith('q:')) await dictionary.addQuizlet(Number(dest.slice(2)), front.trim(), back.trim());
      else await dictionary.addAnki(dest.slice(2), front.trim(), back.trim());
      store.set('search-add-dest', dest);
      onAdded(dests?.find(d => d.key === dest)?.label ?? 'deck');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the card');
    } finally { setSaving(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <form className="bg-(--bg-secondary) rounded-xl max-w-md w-full p-6 space-y-4 section-summary-in" onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); submit(); }}>
        <h3 className="text-lg font-bold">Add as a card</h3>
        <label className="block space-y-1">
          <span className="text-xs text-(--text-secondary)">Front</span>
          <input value={front} onChange={e => setFront(e.target.value)} className="input w-full" autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-(--text-secondary)">Back</span>
          <textarea value={back} onChange={e => setBack(e.target.value)} rows={3} className="input w-full" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-(--text-secondary)">Add to</span>
          <div className="relative">
            <select value={dest} onChange={e => setDest(e.target.value)} className="input w-full appearance-none pr-9 cursor-pointer" disabled={!dests}>
              {!dests && <option>Loading…</option>}
              {dests && ['Quizlet sets', 'Anki decks'].map(g => {
                const items = dests.filter(d => d.group === g);
                return items.length ? <optgroup key={g} label={g}>{items.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}</optgroup> : null;
              })}
            </select>
            <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-(--text-secondary)" />
          </div>
        </label>
        {error && <p className="text-sm text-(--error)">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || !dest} className="btn btn-primary inline-flex items-center gap-2">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Add card</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
