import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/** Anki's own screens (Statistics, Deck Options, Card Info), served by the engine through
 *  /anki-pages and shown exactly as Anki Desktop shows them. */
export type AnkiPagePath = `graphs?deck=${number}` | `graphs?search=${string}` | `deck-options/${number}` | `card-info/${number}`;

function isDark(): boolean {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
  const match = /^#([0-9a-f]{6})$/i.exec(bg);
  if (!match) return true;
  const n = parseInt(match[1], 16);
  const luminance = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 0xff) + 0.114 * (n & 0xff)) / 255;
  return luminance < 0.5;
}

export function ankiPageUrl(path: AnkiPagePath): string {
  const theme = `theme=${isDark() ? 'dark' : 'light'}`;
  return `/anki-pages/${path}${path.includes('?') ? '&' : '?'}${theme}`;
}

interface AnkiPageModalProps {
  title: string;
  path: AnkiPagePath;
  onClose: () => void;
  /** Deck Options was saved (the modal closes itself afterwards). */
  onSaved?: () => void;
}

export function AnkiPageModal({ title, path, onClose, onSaved }: AnkiPageModalProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onClose, onSaved });
  callbacks.current = { onClose, onSaved };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.source !== 'anki-cli') return;
      if (event.data.event === 'deckOptionsSaved') {
        callbacks.current.onSaved?.();
        callbacks.current.onClose();
      } else if (event.data.event === 'deckOptionsClose') {
        callbacks.current.onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') callbacks.current.onClose(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-stretch sm:items-center justify-center sm:p-6" onClick={onClose}>
      <div className="bg-(--bg-secondary) w-full sm:max-w-5xl h-full sm:h-[90vh] sm:rounded-xl overflow-hidden flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-4 pb-3 border-b border-(--bg-tertiary)"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))' }}>
          <h2 className="font-semibold truncate">{title}</h2>
          <button onClick={onClose} className="icon-btn" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <iframe ref={frame} src={ankiPageUrl(path)} title={title} className="flex-1 w-full border-0 bg-(--bg-secondary)" />
      </div>
    </div>
  );
}
