const STORAGE_KEY = 'ankibase-accent';

const DEFAULT = { accent: '#e94560', hover: '#ff6b6b' };

function lighten(hex: string, amount = 30): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (n >> 16) + amount);
  const g = Math.min(255, ((n >> 8) & 0xff) + amount);
  const b = Math.min(255, (n & 0xff) + amount);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function applyAccentColor(accent: string, hover?: string) {
  const h = hover ?? lighten(accent);
  const n = parseInt(accent.slice(1), 16);
  const rgb = `${n >> 16}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-hover', h);
  document.documentElement.style.setProperty('--accent-rgb', rgb);
}

export function loadAccentColor() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const { accent, hover } = JSON.parse(saved);
      applyAccentColor(accent, hover);
    }
  } catch {}
}

export function saveAccentColor(accent: string, hover?: string) {
  const h = hover ?? lighten(accent);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ accent, hover: h }));
  applyAccentColor(accent, h);
}

export function getAccentColor(): { accent: string; hover: string } {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return DEFAULT;
}

export const ACCENT_PRESETS = [
  { name: 'Rose',    accent: '#e94560', hover: '#ff6b6b' },
  { name: 'Blue',    accent: '#3b82f6', hover: '#60a5fa' },
  { name: 'Purple',  accent: '#8b5cf6', hover: '#a78bfa' },
  { name: 'Emerald', accent: '#10b981', hover: '#34d399' },
  { name: 'Orange',  accent: '#f97316', hover: '#fb923c' },
  { name: 'Cyan',    accent: '#06b6d4', hover: '#22d3ee' },
  { name: 'Amber',   accent: '#f59e0b', hover: '#fbbf24' },
];
