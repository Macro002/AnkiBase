import { useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X, Minus, Plus } from 'lucide-react';
import { ACCENT_CHARS } from './shared';

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 p-0 rounded-full transition-colors shrink-0 ${on ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-(--bg-tertiary) p-0.5">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${value === o.value ? 'bg-(--accent) text-white' : 'text-(--text-secondary) hover:text-white'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="p-6 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="font-medium text-sm">{title}</p>
        {hint && <p className="text-xs text-(--text-secondary) mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** Number input with themed −/+ buttons instead of the browser's spinner. */
export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const btn = 'w-8 h-8 rounded-md flex items-center justify-center text-(--text-secondary) hover:text-white hover:bg-white/8 transition-colors disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="inline-flex items-center rounded-lg bg-(--bg-tertiary) p-0.5">
      <button type="button" className={btn} disabled={value <= min} onClick={() => onChange(clamp(value - 1))} aria-label="Fewer"><Minus className="w-3.5 h-3.5" /></button>
      <input type="text" inputMode="numeric" value={value}
        onChange={e => { const n = parseInt(e.target.value.replace(/\D/g, ''), 10); onChange(clamp(Number.isNaN(n) ? min : n)); }}
        onFocus={e => e.target.select()}
        className="w-12 bg-transparent text-center text-sm font-semibold tabular-nums outline-none" />
      <button type="button" className={btn} disabled={value >= max} onClick={() => onChange(clamp(value + 1))} aria-label="More"><Plus className="w-3.5 h-3.5" /></button>
    </div>
  );
}

/** Right-hand slide-in settings panel, same look and open/close animation as the Flashcards options panel. */
export function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 200);
  };
  return createPortal(
    <div className="fixed inset-0 z-[100] flex justify-end bg-black/50 transition-opacity duration-200" style={{ opacity: closing ? 0 : 1 }} onClick={close}>
      <div className={`${closing ? 'options-panel-closing' : 'options-panel'} bg-(--bg-secondary) border-l border-(--bg-tertiary) w-full max-w-sm h-screen overflow-y-auto shadow-2xl flex flex-col divide-y divide-white/8`}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-6 shrink-0" style={{ paddingTop: 'calc(1.5rem + env(safe-area-inset-top, 0px))' }}>
          <h2 className="text-xl font-bold">{title}</h2>
          <button className="icon-btn" onClick={close} title="Close"><X className="w-5 h-5" /></button>
        </div>
        {children}
        <div style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} />
      </div>
    </div>,
    document.body,
  );
}

/** Buttons that insert accented letters at the caret — Quizlet shows these for language sets. */
export function AccentBar({ inputRef, onInsert }: { inputRef: RefObject<HTMLInputElement | null>; onInsert: (next: string) => void }) {
  const insert = (ch: string, upper: boolean) => {
    const el = inputRef.current;
    if (!el) return;
    const c = upper ? ch.toUpperCase() : ch;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + c + el.value.slice(end);
    onInsert(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + c.length, start + c.length);
    });
  };
  return (
    <div className="flex flex-wrap gap-1" title="Shift-click for uppercase">
      {ACCENT_CHARS.map(ch => (
        <button key={ch} type="button" tabIndex={-1}
          onMouseDown={e => { e.preventDefault(); insert(ch, e.shiftKey); }}
          className="min-w-7 h-7 px-1.5 rounded bg-(--bg-tertiary) hover-bg-accent text-sm transition-colors">
          {ch}
        </button>
      ))}
    </div>
  );
}

export function Html({ html, className }: { html: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
