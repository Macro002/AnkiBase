import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, Cloud, HardDrive, Layers, Loader2, Server, Sparkles, Smartphone, User, Users, Wand2 } from 'lucide-react';
import { ankiweb, settings as settingsApi, setup, sync, syncServer, type ProviderInfo } from '../api';
import { Logo } from '../components/Logo';
import { LANGUAGES } from '../i18n';

type Step = 'welcome' | 'admin' | 'profile' | 'sync' | 'ai' | 'done';
const STEPS: Step[] = ['welcome', 'admin', 'profile', 'sync', 'ai', 'done'];

interface Progress { type: 'step' | 'log' | 'done' | 'error'; message: string; progress?: number }

function Dots({ step }: { step: Step }) {
  const index = STEPS.indexOf(step);
  return (
    <div className="flex items-center justify-center gap-1.5 mb-6" aria-hidden>
      {STEPS.map((s, i) => (
        <span key={s} className={`h-1.5 rounded-full transition-all duration-300 ${i === index ? 'w-6 bg-(--accent)' : i < index ? 'w-1.5 bg-(--accent)/60' : 'w-1.5 bg-(--bg-tertiary)'}`} />
      ))}
    </div>
  );
}

function Heading({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="mb-5">
      <div className="w-11 h-11 rounded-2xl bg-(--accent)/15 text-(--accent) flex items-center justify-center mb-3">{icon}</div>
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="text-sm text-(--text-secondary) mt-1 leading-relaxed">{text}</p>
    </div>
  );
}

// ─── Welcome ─────────────────────────────────────────────────────────────────

function Welcome({ next }: { next: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="text-center space-y-5">
      <Logo className="w-16 h-16 mx-auto" />
      <div>
        <h1 className="text-2xl font-bold">{t('setup.welcome')}</h1>
        <p className="text-sm text-(--text-secondary) mt-2 leading-relaxed">{t('setup.welcomeText')}</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
        {LANGUAGES.map(l => (
          <button key={l.code} onClick={() => i18n.changeLanguage(l.code)}
            className={`h-9 rounded-lg text-sm transition-colors ${i18n.resolvedLanguage === l.code ? 'bg-(--accent) text-white' : 'bg-(--bg-tertiary) text-(--text-secondary) hover:text-(--text-primary)'}`}>
            {l.name}
          </button>
        ))}
      </div>
      <button onClick={next} className="btn btn-primary w-full h-12 flex items-center justify-center gap-2">{t('setup.start')} <ArrowRight className="w-4 h-4" /></button>
    </div>
  );
}

// ─── Admin ───────────────────────────────────────────────────────────────────

function Admin({ next }: { next: () => void }) {
  const { t, i18n } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (username.trim().length < 2) return setError(t('setup.usernameShort'));
    if (password.length < 8) return setError(t('setup.passwordShort'));
    if (password !== confirm) return setError(t('setup.passwordMismatch'));
    setLoading(true);
    try {
      await setup.createAdmin(username.trim(), password, i18n.resolvedLanguage);
      next();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('setup.failed'));
    } finally { setLoading(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Heading icon={<User className="w-5 h-5" />} title={t('setup.adminTitle')} text={t('setup.adminText')} />
      <input className="input w-full" value={username} onChange={e => setUsername(e.target.value)} placeholder={t('login.username')}
        autoFocus autoCapitalize="off" autoCorrect="off" autoComplete="username" aria-label={t('login.username')} />
      <input className="input w-full" type="password" value={password} onChange={e => setPassword(e.target.value)}
        placeholder={t('setup.passwordPlaceholder')} autoComplete="new-password" aria-label={t('login.password')} />
      <input className="input w-full" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
        placeholder={t('setup.confirmPlaceholder')} autoComplete="new-password" aria-label={t('setup.confirmPlaceholder')} />
      {error && <p className="text-sm text-(--error)">{error}</p>}
      <button className="btn btn-primary w-full h-11 flex items-center justify-center gap-2" disabled={loading}>
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}{t('setup.continue')}
      </button>
    </form>
  );
}

// ─── Profile ─────────────────────────────────────────────────────────────────

function Profile({ next }: { next: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('Default');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true); setError(''); setProgress(5);
    let finished = false;
    try {
      await setup.createProfile(name.trim() || 'Default', raw => {
        const event = raw as Progress;
        if (event.progress !== undefined) setProgress(event.progress);
        if (event.type === 'error') { setError(event.message); finished = true; }
        else if (event.type === 'done') { finished = true; setMessage(event.message); setTimeout(next, 600); }
        else setMessage(event.message);
      });
      if (!finished) setError(t('setup.connectionLost'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('setup.failed'));
    } finally {
      if (!finished) setRunning(false);
    }
  };

  return (
    <form onSubmit={create} className="space-y-4">
      <Heading icon={<Layers className="w-5 h-5" />} title={t('setup.profileTitle')} text={t('setup.profileText')} />
      <input className="input w-full" value={name} onChange={e => setName(e.target.value)} disabled={running}
        placeholder="Default" aria-label={t('setup.profileName')} />
      {running && !error ? (
        <div className="space-y-2 anim-rise">
          <div className="h-2 rounded-full bg-(--bg-tertiary) overflow-hidden">
            <div className="h-full bg-(--accent) transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-sm text-(--text-secondary) flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{message || t('setup.working')}</p>
        </div>
      ) : (
        <button className="btn btn-primary w-full h-11 flex items-center justify-center gap-2" disabled={!name.trim()}>
          <ArrowRight className="w-4 h-4" />{error ? t('setup.retry') : t('setup.createProfile')}
        </button>
      )}
      {error && <p className="text-sm text-(--error) whitespace-pre-line">{error}</p>}
    </form>
  );
}

// ─── Sync ────────────────────────────────────────────────────────────────────

type SyncChoice = 'ankiweb' | 'own' | 'here' | 'none';

function SyncStep({ next }: { next: () => void }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<SyncChoice | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setResult('');
    try {
      let address: string | null = choice === 'own' ? endpoint.trim() : null;
      if (choice === 'here') {
        setBusy(t('setup.startingSyncServer'));
        await syncServer.addAccount(email.trim(), password);
        const status = await syncServer.start();
        address = status.url ?? (await syncServer.status()).url;
      }
      setBusy(t('setup.loggingIn'));
      await ankiweb.login(email.trim(), password, address);
      setBusy(t('setup.syncing'));
      const synced = await sync.trigger();
      setResult(synced.outcome === 'fullDownload' ? t('setup.downloaded') : t('setup.synced'));
      setTimeout(next, 900);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('setup.failed');
      setError(message.includes('Full sync required') ? t('setup.chooseLater') : message);
    } finally { setBusy(''); }
  };

  const options: { id: SyncChoice; icon: React.ReactNode; title: string; text: string }[] = [
    { id: 'ankiweb', icon: <Cloud className="w-5 h-5" />, title: 'AnkiWeb', text: t('setup.syncAnkiweb') },
    { id: 'here', icon: <HardDrive className="w-5 h-5" />, title: t('setup.syncHereTitle'), text: t('setup.syncHere') },
    { id: 'own', icon: <Server className="w-5 h-5" />, title: t('setup.syncOwnTitle'), text: t('setup.syncOwn') },
    { id: 'none', icon: <Wand2 className="w-5 h-5" />, title: t('setup.syncNoneTitle'), text: t('setup.syncNone') },
  ];

  if (!choice) {
    return (
      <div className="space-y-3">
        <Heading icon={<Cloud className="w-5 h-5" />} title={t('setup.syncTitle')} text={t('setup.syncText')} />
        {options.map(o => (
          <button key={o.id} onClick={() => (o.id === 'none' ? next() : setChoice(o.id))}
            className="w-full flex items-start gap-3 text-left rounded-xl p-3.5 border border-(--bg-tertiary) hover:border-(--accent) transition-colors">
            <span className="w-9 h-9 rounded-xl bg-(--bg-tertiary) text-(--accent) flex items-center justify-center shrink-0">{o.icon}</span>
            <span className="min-w-0">
              <span className="block font-medium">{o.title}</span>
              <span className="block text-xs text-(--text-secondary) leading-relaxed mt-0.5">{o.text}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  const option = options.find(o => o.id === choice)!;
  return (
    <form onSubmit={connect} className="space-y-3">
      <Heading icon={option.icon} title={option.title} text={choice === 'here' ? t('setup.syncHereForm') : option.text} />
      {choice === 'own' && (
        <input className="input w-full" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://sync.example.com/"
          inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label={t('setup.syncAddress')} required />
      )}
      <input className="input w-full" value={email} onChange={e => setEmail(e.target.value)} required
        placeholder={choice === 'ankiweb' ? t('ankiweb.emailPlaceholder') : t('login.username')}
        autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="username" aria-label={t('login.username')} />
      <input className="input w-full" type="password" value={password} onChange={e => setPassword(e.target.value)} required
        minLength={choice === 'here' ? 6 : undefined} placeholder={t('login.password')}
        autoComplete={choice === 'here' ? 'new-password' : 'current-password'} aria-label={t('login.password')} />
      {busy && <p className="text-sm text-(--text-secondary) flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{busy}</p>}
      {result && <p className="text-sm text-green-400 flex items-center gap-2"><Check className="w-4 h-4" />{result}</p>}
      {error && <p className="text-sm text-(--error)">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => { setChoice(null); setError(''); }} className="btn btn-secondary">{t('setup.back')}</button>
        <button className="btn btn-primary flex-1" disabled={!!busy}>{t('setup.connect')}</button>
      </div>
      {error && <button type="button" onClick={next} className="w-full text-sm text-(--text-secondary) hover:text-(--text-primary)">{t('setup.skipForNow')}</button>}
    </form>
  );
}

// ─── AI ──────────────────────────────────────────────────────────────────────

function Ai({ next }: { next: () => void }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({});
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');  // the "custom" provider: a local or OpenAI-compatible server
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    settingsApi.getProviders().then(p => {
      setProviders(p.providers);
      setProvider(Object.keys(p.providers)[0] ?? '');
    }).catch(() => {});
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (provider === 'custom') await settingsApi.setApiKey(provider, key.trim(), '', url.trim());
      else await settingsApi.setApiKey(provider, key.trim());
      next();
    }
    catch (err) { setError(err instanceof Error ? err.message : t('setup.failed')); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <Heading icon={<Sparkles className="w-5 h-5" />} title={t('setup.aiTitle')} text={t('setup.aiText')} />
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(providers).map(([id, info]) => (
          <button type="button" key={id} onClick={() => setProvider(id)}
            className={`px-3 h-9 rounded-lg text-sm ${provider === id ? 'bg-(--accent) text-white' : 'bg-(--bg-tertiary) text-(--text-secondary)'}`}>{info.name}</button>
        ))}
      </div>
      {provider === 'custom' && (
        <input type="url" className="input w-full font-mono text-sm" value={url} onChange={e => setUrl(e.target.value)} placeholder={t('setup.serverUrl')}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label={t('setup.serverUrl')} />
      )}
      <input className="input w-full font-mono text-sm" value={key} onChange={e => setKey(e.target.value)}
        placeholder={t(provider === 'custom' ? 'setup.apiKeyOptional' : 'setup.apiKey')}
        autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label={t('setup.apiKey')} />
      {error && <p className="text-sm text-(--error)">{error}</p>}
      <button className="btn btn-primary w-full h-11" disabled={busy || !(provider === 'custom' ? url : key).trim() || !provider}>{busy ? t('setup.saving') : t('setup.saveKey')}</button>
      <button type="button" onClick={next} className="w-full text-sm text-(--text-secondary) hover:text-(--text-primary) py-1">{t('setup.skipForNow')}</button>
    </form>
  );
}

// ─── Done ────────────────────────────────────────────────────────────────────

function Done() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tips = [
    { icon: <Users className="w-4 h-4" />, text: t('setup.tipUsers') },
    { icon: <HardDrive className="w-4 h-4" />, text: t('setup.tipSync') },
    { icon: <Smartphone className="w-4 h-4" />, text: t('setup.tipPhone') },
  ];
  return (
    <div className="space-y-5">
      <Heading icon={<Check className="w-5 h-5" />} title={t('setup.doneTitle')} text={t('setup.doneText')} />
      <ul className="space-y-2">
        {tips.map((tip, i) => (
          <li key={i} className="flex items-start gap-3 rounded-xl bg-(--bg-tertiary)/50 p-3 text-sm">
            <span className="text-(--accent) mt-0.5">{tip.icon}</span><span className="text-(--text-secondary)">{tip.text}</span>
          </li>
        ))}
      </ul>
      <button onClick={() => navigate('/', { replace: true })} className="btn btn-primary w-full h-12 flex items-center justify-center gap-2">
        {t('setup.open')} <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── The wizard ──────────────────────────────────────────────────────────────

export function Setup() {
  const [step, setStep] = useState<Step | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setup.status().then(s => {
      if (s.needs_setup) setStep('welcome');
      else if (!s.has_container) setStep('profile');  // an admin exists: logged in to get here
      else navigate('/', { replace: true });
    }).catch(() => setStep('welcome'));
  }, [navigate]);

  const go = (to: Step) => () => setStep(to);

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-(--bg-primary) safe-pad-y">
      <div className="w-full max-w-md">
        {step && step !== 'welcome' && (
          <div className="flex items-center justify-center gap-2 mb-4">
            <Logo className="w-7 h-7" /><span className="font-bold text-(--accent)">AnkiBase</span>
          </div>
        )}
        {step && <Dots step={step} />}
        <div key={step ?? 'loading'} className="card anim-rise">
          {!step && <div className="h-40 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-(--accent)" /></div>}
          {step === 'welcome' && <Welcome next={go('admin')} />}
          {step === 'admin' && <Admin next={go('profile')} />}
          {step === 'profile' && <Profile next={go('sync')} />}
          {step === 'sync' && <SyncStep next={go('ai')} />}
          {step === 'ai' && <Ai next={go('done')} />}
          {step === 'done' && <Done />}
        </div>
      </div>
    </div>
  );
}
