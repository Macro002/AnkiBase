/** Keep Bluetooth headphones awake while studying (Settings → Studying).
 *
 *  Bluetooth audio goes idle when nothing plays and takes a moment to wake up, which cuts
 *  off the start of a card's audio. While a deck is open, this plays a noise far too quiet
 *  to hear (about -80 dB) so the link stays up, like Anki's SoundKeeper add-on. Not digital
 *  silence: some systems spot that and let the headphones sleep anyway. */
import { useEffect } from 'react';

const KEY = 'ankibase.keepAudioAwake';
const LEVEL = 1e-4;

export function keepAudioAwakeEnabled(): boolean {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

export function setKeepAudioAwake(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
}

let context: AudioContext | null = null;

function start() {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return;
  if (!context) {
    context = new Context();
    // Two seconds of faint noise, looped.
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * LEVEL;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(context.destination);
    source.start();
  }
  // Browsers only let audio start after a tap; useKeepAudioAwake resumes on the next one.
  context.resume().catch(() => {});
}

/** Suspended, the headphones may go idle again (outside studying, or in the background). */
function pause() {
  context?.suspend().catch(() => {});
}

/** While `active` (a deck is open) and the setting is on. */
export function useKeepAudioAwake(active: boolean) {
  useEffect(() => {
    if (!active || !keepAudioAwakeEnabled()) return;
    const resume = () => { if (document.visibilityState === 'visible') start(); };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : pause());
    start();
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      document.removeEventListener('visibilitychange', onVisibility);
      pause();
    };
  }, [active]);
}
