import { useEffect, useRef, useState } from 'react';
import { decks } from '../api';
import { isIOS } from '../native';

/** How many top-level decks are behind today (reviews or learning cards due): the Study
 *  tab's badge. The iPhone app asks its engine, as the icon's badge does (Reminders.swift),
 *  so the two agree; elsewhere it's counted from the decks' due counts. */
async function countBehind(): Promise<number> {
  if (isIOS) {
    const r = await fetch('/api/app/behind');
    if (r.ok) {
      const { days } = await r.json() as { days: { decks: string[] }[] };
      return days[0]?.decks.length ?? 0;
    }
  }
  const data = await decks.list();
  return Object.entries(data.decks).filter(([name, id]) => {
    const stats = data.stats[id];
    return !name.includes('::') && !!stats && stats.review_count + stats.learn_count > 0;
  }).length;
}

/** The count, kept fresh: after a sync, when the app comes back, and after studying
 *  (`studying` turning false). */
export function useStudyBadge(studying: boolean): number {
  const [count, setCount] = useState(0);
  const wasStudying = useRef(studying);

  useEffect(() => {
    let live = true;
    const refresh = () => { countBehind().then(n => { if (live) setCount(n); }).catch(() => {}); };
    refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('anki-sync-complete', refresh);
    document.addEventListener('visibilitychange', onVisible);
    // Back from studying.
    window.addEventListener('ankibase-studied', refresh);
    return () => {
      live = false;
      window.removeEventListener('anki-sync-complete', refresh);
      window.removeEventListener('ankibase-studied', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (wasStudying.current && !studying) window.dispatchEvent(new CustomEvent('ankibase-studied'));
    wasStudying.current = studying;
  }, [studying]);

  return count;
}
