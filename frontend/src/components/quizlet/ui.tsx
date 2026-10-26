import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X, Minus, Plus, Check } from 'lucide-react';
import { ACCENT_CHARS } from './shared';
import { useSpring } from '../../hooks/useSpring';

/** On/off switch whose knob springs across (stretching a little while it moves). */
export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const knob = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  const spring = useSpring<'x'>(({ x }) => {
    const speed = Math.abs(x - prev.current);
    prev.current = x;
    if (knob.current) knob.current.style.transform = `translateX(${x}px) scaleX(${1 + Math.min(0.25, speed / 8)})`;
  }, { stiffness: 600, damping: 22 });
  const first = useRef(true);
  useLayoutEffect(() => {
    spring.set({ x: on ? 16 : 0 }, first.current);
    first.current = false;
  }, [on, spring]);
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 p-0 rounded-full transition-colors duration-200 shrink-0 ${on ? 'bg-(--accent)' : 'bg-(--bg-tertiary)'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      <span ref={knob} className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm" />
    </button>
  );
}

const SEG_SIZE = {
  md: { box: 'h-9 p-1', btn: 'h-7 px-3 text-xs' },
  sm: { box: 'h-8 p-[3px]', btn: 'h-[26px] px-2.5 text-xs' },
} as const;

/** Single-choice slider: the highlight springs to the selected option. */
export function Segmented<T extends string>({ value, options, onChange, size = 'sm' }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; size?: keyof typeof SEG_SIZE;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const spring = useSpring<'x' | 'w'>(({ x, w }) => {
    if (pill.current) { pill.current.style.transform = `translateX(${x}px)`; pill.current.style.width = `${w}px`; }
  });
  const first = useRef(true);

  const place = useCallback((immediate: boolean) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(value)}"]`);
    if (!el) return;
    spring.set({ x: el.offsetLeft, w: el.offsetWidth }, immediate);
  }, [value, spring]);

  useLayoutEffect(() => {
    place(first.current);
    first.current = false;
  }, [place]);

  // Re-measure on resize (fonts loading, panel opening) — subscribed once; a fresh
  // observer fires immediately, which would otherwise cut the slide animation short.
  const placeRef = useRef(place);
  useLayoutEffect(() => { placeRef.current = place; }, [place]);
  useLayoutEffect(() => {
    if (!box.current || typeof ResizeObserver === 'undefined') return;
    let firstCall = true;
    const ro = new ResizeObserver(() => { if (firstCall) { firstCall = false; return; } placeRef.current(true); });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const sz = SEG_SIZE[size];
  return (
    <div ref={box} role="radiogroup" className={`relative inline-flex items-center rounded-lg bg-(--bg-tertiary) ${sz.box}`}>
      <span ref={pill} aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 rounded-md bg-(--accent) shadow-sm pointer-events-none"
        style={{ height: size === 'md' ? 28 : 26, width: 0 }} />
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} data-seg={o.value}
          onClick={() => onChange(o.value)}
          className={`relative z-10 rounded-md font-medium whitespace-nowrap transition-colors duration-200 ${sz.btn} ${value === o.value ? 'text-white' : 'text-(--text-secondary) hover:text-white'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select option chip (e.g. data sources) — independent on/off, with a check that pops in. */
export function CheckChip({ on, onChange, children, disabled }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      className={`h-9 px-3 rounded-lg inline-flex items-center gap-2 text-xs font-medium border transition-colors duration-200 ${
        on ? 'bg-(--accent)/15 border-(--accent)/60 text-white' : 'bg-(--bg-tertiary) border-transparent text-(--text-secondary) hover:text-white'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
      <span className={`w-4 h-4 rounded-[5px] flex items-center justify-center transition-all duration-200 ${on ? 'bg-(--accent)' : 'bg-white/10'}`}>
        <Check className={`w-3 h-3 text-white transition-transform duration-300 ${on ? 'scale-100' : 'scale-0'}`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }} strokeWidth={3} />
      </span>
      {children}
    </button>
  );
}

/** Small ‹ value › switcher (e.g. year), styled like the other controls. */
export function PrevNext({ label, onPrev, onNext, prevDisabled, nextDisabled }: {
  label: ReactNode; onPrev: () => void; onNext: () => void; prevDisabled?: boolean; nextDisabled?: boolean;
}) {
  const btn = 'w-[26px] h-[26px] rounded-md flex items-center justify-center text-(--text-secondary) hover:text-white hover:bg-white/8 transition-colors disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="inline-flex items-center h-8 p-[3px] rounded-lg bg-(--bg-tertiary)">
      <button type="button" className={btn} onClick={onPrev} disabled={prevDisabled} aria-label="Previous">‹</button>
      <span className="px-2 text-xs font-semibold tabular-nums">{label}</span>
      <button type="button" className={btn} onClick={onNext} disabled={nextDisabled} aria-label="Next">›</button>
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
