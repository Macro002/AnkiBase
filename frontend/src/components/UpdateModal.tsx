import { useState, useRef, useEffect } from 'react';
import { X, RefreshCw, Loader2, Copy, Check } from 'lucide-react';
import { update } from '../api';

interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ProgressEvent {
  type: 'step' | 'log' | 'done' | 'error';
  message: string;
  progress?: number;
}

export function UpdateModal({ isOpen, onClose }: UpdateModalProps) {
  const [started, setStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (!isOpen) {
      esRef.current?.close();
      setStarted(false);
      setProgress(0);
      setLogs([]);
      setDone(false);
      setError('');
    }
  }, [isOpen]);

  const startUpdate = () => {
    setStarted(true);
    setLogs([]);
    setProgress(5);
    setDone(false);
    setError('');

    const es = new EventSource(update.applyUrl(), { withCredentials: true });
    esRef.current = es;

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
        // Wait for service restart then reload
        setTimeout(() => { window.location.reload(); }, 5000);
      } else if (data.type === 'error') {
        setError(data.message);
        setLogs(prev => [...prev, '✗ ' + data.message]);
        es.close();
      }
    };

    es.onerror = () => {
      // Connection drop likely means service restarted — reload
      if (!done && !error) {
        setTimeout(() => { window.location.reload(); }, 3000);
      }
      es.close();
    };
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="card max-w-lg w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5 text-(--accent)" />
            <h2 className="text-xl font-bold">Update AnkiBase</h2>
          </div>
          {(!started || !!error) && (
            <button onClick={onClose} className="icon-btn">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {!started ? (
          <div className="space-y-4">
            <p className="text-(--text-secondary) text-sm">
              A new version is available. This will download the latest code, rebuild
              the frontend, and restart the service. Takes about 1–2 minutes.
            </p>
            <div className="flex gap-3">
              <button className="btn btn-primary flex-1" onClick={startUpdate}>
                Update Now
              </button>
              <button className="btn btn-secondary flex-1" onClick={onClose}>
                Later
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="w-full bg-(--bg-tertiary) rounded-full h-2">
              <div
                className="h-2 rounded-full transition-all duration-500"
                style={{ width: `${progress}%`, background: 'var(--accent)' }}
              />
            </div>
            <p className="text-sm text-center text-(--text-secondary)">{progress}%</p>

            <div className="relative">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(logs.join('\n'));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="absolute top-2 right-2 icon-btn z-10"
                title="Copy logs"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <div
                ref={logRef}
                className="bg-(--bg-secondary) rounded-lg p-3 pr-8 h-48 overflow-y-auto text-xs font-mono text-(--text-secondary) space-y-0.5"
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
            </div>

            {done && (
              <p className="text-sm text-center text-green-400">
                Update complete — reloading in a moment...
              </p>
            )}
            {error && (
              <div className="space-y-1">
                <p className="text-sm text-(--error)">{error}</p>
                <p className="text-xs text-(--text-secondary)">
                  If the update was partially applied, refreshing won't resume it — re-trigger the update from settings.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
