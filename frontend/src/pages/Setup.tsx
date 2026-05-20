import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, ChevronRight, ServerCog, User, Wifi } from 'lucide-react';
import { setup, ankiweb } from '../api';
import { Logo } from '../components/Logo';

type Step = 1 | 2 | 3;

interface ProgressEvent {
  type: 'step' | 'log' | 'done' | 'error';
  message: string;
  progress?: number;
}

function StepIndicator({ current }: { current: Step }) {
  const steps = [
    { n: 1 as Step, label: 'Admin Account' },
    { n: 2 as Step, label: 'Anki Container' },
    { n: 3 as Step, label: 'AnkiWeb' },
  ];
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <div className={`flex items-center gap-2 ${current === s.n ? 'text-(--text-primary)' : current > s.n ? 'text-green-400' : 'text-(--text-secondary)'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors ${
              current > s.n ? 'bg-green-500/20 border-green-400' :
              current === s.n ? 'bg-(--accent)/20 border-(--accent)' :
              'border-(--bg-tertiary)'
            }`}>
              {current > s.n ? <Check className="w-4 h-4" /> : s.n}
            </div>
            <span className="text-sm hidden sm:block">{s.label}</span>
          </div>
          {i < steps.length - 1 && <div className="w-8 h-px bg-(--bg-tertiary)" />}
        </div>
      ))}
    </div>
  );
}

// ─── Step 1: Create Admin ────────────────────────────────────────────────────

function StepAdmin({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    if (!username.trim()) return setError('Username is required');
    if (password.length < 6) return setError('Password must be at least 6 characters');
    if (password !== confirm) return setError('Passwords do not match');
    setLoading(true);
    try {
      await setup.createAdmin(username.trim(), password);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create admin');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-(--accent)/20 flex items-center justify-center">
          <User className="w-5 h-5 text-(--accent)" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Create Admin Account</h2>
          <p className="text-sm text-(--text-secondary)">This will be your main login</p>
        </div>
      </div>

      <div>
        <label className="block text-sm text-(--text-secondary) mb-1">Username</label>
        <input
          className="input w-full"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="admin"
          autoFocus
          onKeyDown={e => e.key === 'Enter' && submit()}
        />
      </div>
      <div>
        <label className="block text-sm text-(--text-secondary) mb-1">Password</label>
        <input
          className="input w-full"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Min. 6 characters"
          onKeyDown={e => e.key === 'Enter' && submit()}
        />
      </div>
      <div>
        <label className="block text-sm text-(--text-secondary) mb-1">Confirm Password</label>
        <input
          className="input w-full"
          type="password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder="Repeat password"
          onKeyDown={e => e.key === 'Enter' && submit()}
        />
      </div>

      {error && <p className="text-sm text-(--error)">{error}</p>}

      <button
        className="btn btn-primary w-full flex items-center justify-center gap-2 mt-2"
        onClick={submit}
        disabled={loading}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
        {loading ? 'Creating...' : 'Continue'}
      </button>
    </div>
  );
}

// ─── Step 2: Container Setup ─────────────────────────────────────────────────

function StepContainer({ onDone }: { onDone: () => void }) {
  const [containerName, setContainerName] = useState('default');
  const [started, setStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const startSetup = () => {
    setStarted(true);
    setLogs([]);
    setProgress(5);
    setDone(false);
    setError('');

    const url = setup.containerStreamUrl(containerName);
    const es = new EventSource(url, { withCredentials: true });

    es.onmessage = (e) => {
      const data: ProgressEvent = JSON.parse(e.data);
      if (data.progress !== undefined) setProgress(data.progress);

      if (data.type === 'step' || data.type === 'log') {
        setLogs(prev => [...prev, data.message]);
      } else if (data.type === 'done') {
        setLogs(prev => [...prev, '✓ ' + data.message]);
        setProgress(100);
        setDone(true);
        es.close();
      } else if (data.type === 'error') {
        setError(data.message);
        setLogs(prev => [...prev, '✗ ' + data.message]);
        es.close();
      }
    };

    es.onerror = () => {
      setError('Connection lost. Check server logs.');
      es.close();
    };
  };

  if (!started) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-full bg-(--accent)/20 flex items-center justify-center">
            <ServerCog className="w-5 h-5 text-(--accent)" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Set Up Anki Container</h2>
            <p className="text-sm text-(--text-secondary)">Pulls and starts the headless Anki Docker container</p>
          </div>
        </div>

        <div>
          <label className="block text-sm text-(--text-secondary) mb-1">Container Name</label>
          <input
            className="input w-full"
            value={containerName}
            onChange={e => setContainerName(e.target.value)}
            placeholder="default"
          />
          <p className="text-xs text-(--text-secondary) mt-1">Used to identify this Anki instance. You can add more later.</p>
        </div>

        <button
          className="btn btn-primary w-full flex items-center justify-center gap-2 mt-2"
          onClick={startSetup}
          disabled={!containerName.trim()}
        >
          <ChevronRight className="w-4 h-4" />
          Set Up Container
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-(--accent)/20 flex items-center justify-center">
          <ServerCog className="w-5 h-5 text-(--accent)" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Setting Up Container</h2>
          <p className="text-sm text-(--text-secondary)">This may take a few minutes on first run</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-(--bg-tertiary) rounded-full h-2">
        <div
          className="h-2 rounded-full transition-all duration-500"
          style={{ width: `${progress}%`, background: 'var(--accent)' }}
        />
      </div>
      <p className="text-sm text-center text-(--text-secondary)">{progress}%</p>

      {/* Log output */}
      <div
        ref={logRef}
        className="bg-(--bg-secondary) rounded-lg p-3 h-40 overflow-y-auto text-xs font-mono text-(--text-secondary) space-y-0.5"
      >
        {logs.map((l, i) => (
          <div key={i} className={l.startsWith('✓') ? 'text-green-400' : l.startsWith('✗') ? 'text-(--error)' : ''}>
            {l}
          </div>
        ))}
        {!done && !error && (
          <div className="flex items-center gap-1 text-(--accent)">
            <Loader2 className="w-3 h-3 animate-spin" /> running...
          </div>
        )}
      </div>

      {error && !done && (
        <p className="text-sm text-(--error)">{error}</p>
      )}

      {(done || error) && (
        <button
          className="btn btn-primary w-full flex items-center justify-center gap-2"
          onClick={onDone}
        >
          <ChevronRight className="w-4 h-4" />
          Continue
        </button>
      )}
    </div>
  );
}

// ─── Step 3: AnkiWeb ─────────────────────────────────────────────────────────

function StepAnkiWeb({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const connect = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError('');
    try {
      await ankiweb.login(email, password);
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-(--accent)/20 flex items-center justify-center">
          <Wifi className="w-5 h-5 text-(--accent)" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Connect AnkiWeb</h2>
          <p className="text-sm text-(--text-secondary)">Optional — sync your cards from AnkiWeb</p>
        </div>
      </div>

      {success ? (
        <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400 flex items-center gap-2">
          <Check className="w-4 h-4" /> Connected to AnkiWeb successfully!
        </div>
      ) : (
        <>
          <div>
            <label className="block text-sm text-(--text-secondary) mb-1">AnkiWeb Email</label>
            <input
              className="input w-full"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm text-(--text-secondary) mb-1">AnkiWeb Password</label>
            <input
              className="input w-full"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Your AnkiWeb password"
            />
          </div>
          {error && <p className="text-sm text-(--error)">{error}</p>}
          <button
            className="btn btn-primary w-full flex items-center justify-center gap-2"
            onClick={connect}
            disabled={loading || !email || !password}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </>
      )}

      <button
        className="btn btn-secondary w-full"
        onClick={onDone}
      >
        {success ? 'Continue to App' : 'Skip for now'}
      </button>
    </div>
  );
}

// ─── Main Setup Page ─────────────────────────────────────────────────────────

export function Setup() {
  const [step, setStep] = useState<Step>(1);
  const navigate = useNavigate();

  useEffect(() => {
    setup.status().then(s => {
      if (s.has_admin && !s.has_container) setStep(2);
    }).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-(--bg-primary)">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Logo className="w-14 h-14 mx-auto mb-3" />
          <h1 className="text-2xl font-bold text-(--accent)">AnkiBase</h1>
          <p className="text-(--text-secondary) text-sm mt-1">First-time setup</p>
        </div>

        <StepIndicator current={step} />

        <div className="card">
          {step === 1 && <StepAdmin onDone={() => setStep(2)} />}
          {step === 2 && <StepContainer onDone={() => setStep(3)} />}
          {step === 3 && <StepAnkiWeb onDone={() => navigate('/')} />}
        </div>
      </div>
    </div>
  );
}
