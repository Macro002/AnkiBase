import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { quizlet, story as storyApi, type DailyStory, type DailyStoryRecipe } from '../../api';
import { Toggle } from '../quizlet/ui';
import { STYLES, dailyRecipe, loadAi, loadPrefs } from '../story/prefs';
import { isIOS, requestStoryAlerts } from '../../native';

const LENGTHS: Record<string, string> = { auto: 'Auto length', short: 'Short', medium: 'Medium', long: 'Long' };

/** What a recipe writes, in a few words. */
function describe(r: DailyStoryRecipe): { label: string; value: string }[] {
  const lang = r.target_language ? `${r.target_language}, translated to ${r.language}`
    : r.language && r.language !== 'auto' ? r.language : 'The words’ language';
  return [
    { label: 'Words', value: `${r.count} from ${(r.deck_name ?? '').replace(/::/g, ' › ')}` },
    { label: 'Story', value: [r.level, STYLES.find(s => s.value === r.style)?.label ?? r.style, LENGTHS[r.length] ?? r.length].filter(Boolean).join(' · ') },
    { label: 'Language', value: lang },
    { label: 'Written by', value: [r.provider, r.model].filter(Boolean).join(' · ') },
  ];
}

/** Settings → AI → Daily story: a new story every day, once the last one is marked read.
 *  It writes with the Story tab's words source and settings (backend/daily_story.py). */
export function DailyStorySection() {
  const [daily, setDaily] = useState<DailyStory | null>(null);
  const [setTitles, setSetTitles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    storyApi.daily().then(d => {
      setDaily(d);
      if (d.enabled) requestStoryAlerts(); // on from before the notifications (iOS asks only once)
    }).catch(() => setDaily({ enabled: false, recipe: null, tz: null }));
    quizlet.listDecks().then(d => setSetTitles(Object.fromEntries(d.decks.map(x => [String(x.id), x.title])))).catch(() => {});
  }, []);

  const prefs = loadPrefs();
  const current = dailyRecipe(prefs, loadAi(), setTitles[prefs.set]);
  const shown = daily?.enabled ? daily.recipe : current;
  const changed = !!(daily?.enabled && current && JSON.stringify(current) !== JSON.stringify(daily.recipe));

  const save = async (enabled: boolean, recipe?: DailyStoryRecipe) => {
    setBusy(true); setError(null);
    try {
      setDaily(await storyApi.setDaily(enabled, recipe));
      if (enabled) requestStoryAlerts(); // the iPhone app notifies when one's ready
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save'); }
    finally { setBusy(false); }
  };

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold">Daily story</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">A new story with fresh words every day, once you’ve marked the last one read.{isIOS && ' You’ll get a notification when it’s ready.'}</p>
        </div>
        <Toggle on={!!daily?.enabled} disabled={!daily || busy || (!daily.enabled && !current && !daily.recipe)}
          onChange={on => save(on, on ? current ?? undefined : undefined)} />
      </div>

      {shown ? (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          {describe(shown).map(row => (
            <div key={row.label} className="contents">
              <dt className="text-(--text-secondary)">{row.label}</dt>
              <dd className="min-w-0 truncate">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : daily && (
        <p className="text-sm text-(--text-secondary)">
          Choose an Anki deck or a Quizlet set and an AI in the <Link to="/story" className="text-(--accent) hover:underline">Story tab</Link> first: the daily story writes with those.
        </p>
      )}

      {shown && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {changed && (
            <button onClick={() => save(true, current ?? undefined)} disabled={busy} className="text-(--accent) hover:underline">
              Use the Story tab’s current settings
            </button>
          )}
          <Link to="/story" className="text-(--text-secondary) hover:text-white">Change these in the Story tab →</Link>
        </div>
      )}
      {error && <p className="text-xs text-(--error)">{error}</p>}
    </section>
  );
}
