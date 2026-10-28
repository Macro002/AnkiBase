import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, KeyRound, Lock, LockOpen, ShieldAlert, Timer } from 'lucide-react';
import { Segmented, Toggle } from '../quizlet/ui';

export interface FocusState {
  available: boolean;
  enabled: boolean;
  strict: boolean;
  strict_until: number | null;
  committed: boolean;
  include_new: boolean;
  min_answer_secs: number;
  passes_per_month: number;
  passes_left: number;
  today: string | null;
  rollover_hour: number | null;
  due: number;
  open: boolean;
  locked: boolean;
  passcodes: { id: number; created: number; reveal_at: number; revealable: boolean }[];
}

async function focusCall<T = FocusState>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`/api/app/focus${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || 'Something went wrong');
  return data as T;
}

const focusApi = { state: () => focusCall('') };

const day = (secs: number) => new Date(secs * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/** Settings → Focus (iPhone): other apps stay closed until today's cards are done. A
 *  Shortcuts automation runs the app's Focus Lock action when they open, which sends you
 *  here while cards are due; Screen Time (with a passcode nobody knows) can guard it. */
export function FocusSection() {
  const [state, setState] = useState<FocusState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [commitDays, setCommitDays] = useState('30');

  useEffect(() => { focusCall('').then(setState).catch(e => setError(e.message)); }, []);

  const change = useCallback(async (patch: Record<string, unknown>) => {
    setError(''); setBusy(true);
    try { setState(await focusCall('', 'PUT', patch)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, []);

  if (!state) return error ? <p className="card text-sm text-(--error)">{error}</p> : <div className="card skeleton h-40" />;

  const usePass = async () => {
    if (!confirm(`Open your apps for the rest of today? ${state.passes_left - 1} pass${state.passes_left - 1 === 1 ? '' : 'es'} left this month after this.`)) return;
    setError('');
    try { setState(await focusCall('/pass', 'POST')); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const goStrict = () => {
    const days = Number(commitDays);
    if (!confirm(`Strict until ${day(Date.now() / 1000 + days * 86400)}?\n\nNo emergency passes, no quick answers, no deleting decks or lowering limits while cards are due, and no turning it off or loosening it before then.`)) return;
    change({ strict: true, strict_days: days });
  };

  const status = !state.enabled
    ? { icon: <LockOpen className="w-5 h-5" />, title: 'Off', text: 'Your apps open as usual.' }
    : state.locked
      ? { icon: <Lock className="w-5 h-5" />, title: `${state.due} card${state.due === 1 ? '' : 's'} to go`, text: 'Blocked apps send you here until they’re done.' }
      : { icon: <CheckCircle2 className="w-5 h-5" />, title: 'Done for today', text: 'Your apps are open until the next day starts.' };

  return (
    <>
      <section className="card space-y-4">
        <div>
          <h3 className="font-semibold">Focus lock</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">
            Keep chosen apps closed until today’s cards are done. Set it up once below.
          </p>
        </div>

        <div className={`rounded-xl p-4 flex items-start gap-3 ${state.locked ? 'bg-(--accent)/10 border border-(--accent)/40' : 'bg-(--bg-tertiary)/60'}`}>
          <span className="w-10 h-10 rounded-full bg-(--accent)/15 text-(--accent) flex items-center justify-center shrink-0">{status.icon}</span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{status.title}</p>
            <p className="text-xs text-(--text-secondary)">{status.text}</p>
            {state.committed && state.strict_until && (
              <p className="text-xs text-(--warning) mt-1">Strict until {day(state.strict_until)}: it can only get stricter until then.</p>
            )}
          </div>
        </div>

        <Row title="Lock my apps" hint="Until nothing is due today.">
          <Toggle on={state.enabled} disabled={busy} onChange={v => change({ enabled: v })} />
        </Row>

        {state.enabled && (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">Mode</p>
              <Segmented value={state.strict ? 'strict' : 'flexible'} full
                options={[{ value: 'flexible', label: 'Flexible' }, { value: 'strict', label: 'Strict' }]}
                onChange={v => v === 'strict' ? goStrict() : change({ strict: false })} />
              {!state.strict ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-(--text-secondary)">
                  <span>Strict for</span>
                  <Segmented value={commitDays} size="sm" onChange={setCommitDays}
                    options={[{ value: '7', label: '1 week' }, { value: '30', label: '1 month' }, { value: '90', label: '3 months' }]} />
                </div>
              ) : (
                <p className="text-xs text-(--text-secondary)">No emergency passes. While cards are due, decks can’t be deleted and daily limits can’t be lowered.</p>
              )}
            </div>

            <Row title="New cards count too" hint="Off: only reviews and learning cards.">
              <Toggle on={state.include_new} disabled={busy} onChange={v => change({ include_new: v })} />
            </Row>

            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-1.5"><Timer className="w-4 h-4" /> Time per card</p>
              <p className="text-xs text-(--text-secondary)">Answers sooner than this after a card appears don’t go through, so you can’t just tap through.</p>
              <Segmented value={String(state.min_answer_secs)} full onChange={v => change({ min_answer_secs: Number(v) })}
                options={[{ value: '0', label: 'Off' }, { value: '2', label: '2 s' }, { value: '3', label: '3 s' }, { value: '5', label: '5 s' }]} />
            </div>

            {!state.strict && (
              <div className="space-y-2">
                <p className="text-sm font-medium flex items-center gap-1.5"><ShieldAlert className="w-4 h-4" /> Emergency passes</p>
                <p className="text-xs text-(--text-secondary)">Open your apps for one day without finishing. Per month:</p>
                <Segmented value={String(state.passes_per_month)} full onChange={v => change({ passes_per_month: Number(v) })}
                  options={['0', '1', '2', '3', '5'].map(n => ({ value: n, label: n }))} />
                {state.locked && state.passes_left > 0 && (
                  <button onClick={usePass} className="btn btn-secondary w-full">Use a pass today ({state.passes_left} left)</button>
                )}
              </div>
            )}
          </>
        )}
        {error && <p className="text-sm text-(--error)">{error}</p>}
      </section>

      <SetupGuide state={state} />
      <Passcodes state={state} onChange={setState} />
    </>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-(--text-secondary)">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="w-6 h-6 rounded-full bg-(--accent)/15 text-(--accent) text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5">{n}</span>
      <div className="min-w-0 text-sm space-y-1"><p className="font-medium">{title}</p><div className="text-(--text-secondary) text-xs space-y-1">{children}</div></div>
    </li>
  );
}

/** The one-time setup: one automation running the app's Focus Lock action, then (to make
 *  it stick) Screen Time to guard it. */
function SetupGuide({ state }: { state: FocusState }) {
  const [open, setOpen] = useState(!state.enabled);
  const [guard, setGuard] = useState(state.strict);
  return (
    <section className="card space-y-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between text-left">
        <div>
          <h3 className="font-semibold">Set it up (once)</h3>
          <p className="text-xs text-(--text-secondary) mt-0.5">One automation in Shortcuts, about a minute.</p>
        </div>
        <ChevronDown className={`w-5 h-5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <ol className="space-y-3">
            <Step n={1} title="New automation">
              <p>In Shortcuts: <b>Automation</b> → <b>+</b> → <b>App</b>. Choose the apps to keep closed, then <b>Run Immediately</b> → <b>Next</b>.</p>
            </Step>
            <Step n={2} title="Add “Focus Lock”">
              <p><b>New Blank Automation</b>, search the actions for <b>Focus Lock</b> (AnkiBase), tap it, then <b>Done</b>. That’s it.</p>
            </Step>
          </ol>
          <a href="shortcuts://" className="btn btn-primary w-full">Open Shortcuts</a>
          <p className="text-xs text-(--text-secondary)">
            Then open one of those apps: AnkiBase comes up instead while cards are due{state.rollover_hour != null && <>. Your day starts at {state.rollover_hour}:00, like Anki’s</>}.
          </p>

          <div className="border-t border-(--border) pt-3 space-y-3">
            <button onClick={() => setGuard(g => !g)} className="w-full flex items-center justify-between text-left">
              <div>
                <p className="text-sm font-semibold">Make it hard to undo</p>
                <p className="text-xs text-(--text-secondary)">Optional. In Settings › Screen Time, so you can’t switch the automation off.</p>
              </div>
              <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${guard ? 'rotate-180' : ''}`} />
            </button>
            {guard && (
              <ol className="space-y-3">
                <Step n={1} title="Block the Shortcuts app">
                  <p><b>App Limits</b> → <b>Add Limit</b> → Shortcuts, <b>1 min</b>, <b>Block at End of Limit</b> on.</p>
                </Step>
                <Step n={2} title="No deleting apps">
                  <p><b>Content & Privacy Restrictions</b> on → <b>App Store Purchases</b> → <b>Deleting Apps</b>: <b>Don’t Allow</b>.</p>
                </Step>
                <Step n={3} title="A passcode you don’t know">
                  <p><b>Lock Screen Time Settings</b> with a code from <b>Passcodes</b> below. When it asks for an Apple Account, tap <b>Cancel</b>: otherwise “Forgot passcode?” undoes all of this.</p>
                </Step>
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Screen Time passcodes nobody knows: shown once, kept time-locked with drand. */
function Passcodes({ state, onChange }: { state: FocusState; onChange: (s: FocusState) => void }) {
  const [days, setDays] = useState('30');
  const [made, setMade] = useState<{ code: string; reveal_at: number } | null>(null);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [error, setError] = useState('');

  const make = async () => {
    setError('');
    try {
      const r = await focusCall<{ code: string; reveal_at: number; state: FocusState }>('/passcode', 'POST', { days: Number(days) });
      setMade({ code: r.code, reveal_at: r.reveal_at });
      onChange(r.state);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const reveal = async (id: number) => {
    setError('');
    try {
      const r = await focusCall<{ code: string }>('/passcode/reveal', 'POST', { id });
      setRevealed(v => ({ ...v, [id]: r.code }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <section className="card space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4" /> Passcodes</h3>
        <p className="text-xs text-(--text-secondary) mt-0.5">
          A Screen Time passcode you can’t know. It’s shown once so you can type it into Settings, then sealed with drand’s
          public time lock: nobody (not you, not this app) can open it before the date you pick.
        </p>
      </div>

      {made ? (
        <div className="rounded-xl border border-(--accent)/40 bg-(--accent)/10 p-4 space-y-3 text-center">
          <p className="text-xs text-(--text-secondary)">Type this into Screen Time twice now. Don’t write it down.</p>
          <p className="text-4xl font-mono tracking-[0.4em] font-semibold select-none">{made.code}</p>
          <p className="text-xs text-(--text-secondary)">Opens again on {day(made.reveal_at)}.</p>
          <button onClick={() => setMade(null)} className="btn btn-primary w-full">I’ve set it, hide it</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Opens after</span>
          <Segmented value={days} onChange={setDays}
            options={[{ value: '7', label: '1 week' }, { value: '30', label: '1 month' }, { value: '90', label: '3 months' }]} />
          <button onClick={make} className="btn btn-secondary ml-auto">Make a passcode</button>
        </div>
      )}

      {state.passcodes.length > 0 && (
        <ul className="divide-y divide-(--border)">
          {[...state.passcodes].reverse().map(p => (
            <li key={p.id} className="py-2 flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="block">Made {day(p.created)}</span>
                <span className="block text-xs text-(--text-secondary)">{p.revealable ? 'Can be opened' : `Sealed until ${day(p.reveal_at)}`}</span>
              </span>
              {revealed[p.id]
                ? <span className="font-mono text-lg tracking-widest">{revealed[p.id]}</span>
                : <button onClick={() => reveal(p.id)} disabled={!p.revealable} className="btn btn-secondary disabled:opacity-40">
                    {p.revealable ? 'Open' : <Lock className="w-4 h-4" />}
                  </button>}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-(--error)">{error}</p>}
    </section>
  );
}

/** On the decks page while the lock holds: why a blocked app sent you here. */
export function FocusBanner() {
  const [state, setState] = useState<FocusState | null>(null);
  useEffect(() => {
    const load = () => focusApi.state().then(setState).catch(() => {});
    load();
    window.addEventListener('anki-sync-complete', load);
    return () => window.removeEventListener('anki-sync-complete', load);
  }, []);
  if (!state?.locked) return null;
  return (
    <a href="/settings?tab=focus" className="rounded-xl border border-(--accent)/40 bg-(--accent)/10 px-4 py-3 flex items-center gap-3 text-sm">
      <Lock className="w-4 h-4 text-(--accent) shrink-0" />
      <span className="flex-1 min-w-0">Focus lock: <b>{state.due}</b> card{state.due === 1 ? '' : 's'} before your apps open.</span>
    </a>
  );
}
