import { signal, effect } from '@preact/signals';
import { load, save, loadLegacy } from './core/storage';

export type ThemeId = 'grau' | 'pink' | 'feldgrau' | 'hell';
export type Density = 'compact' | 'comfortable';
export type MotionPref = 'auto' | 'reduced' | 'off';

export interface Settings {
  theme: ThemeId;
  /** Eigener Farbton (OKLCH-Hue 0–360) oder null für die Farbe des Themes. */
  accentHue: number | null;
  density: Density;
  /** Glas-Intensität 0 (deckend) bis 1 (stark durchscheinend). */
  glass: number;
  motion: MotionPref;
  sidebarCollapsed: boolean;
  favorites: string[];
  recents: string[];
  characterId: string | null;
  characterName: string | null;
  countryId: string | null;
  notifyLive: boolean;
}

export const GERMANY_ID = '6813b6d446e731854c7ac79c';

export const THEMES: { id: ThemeId; name: string; hint: string }[] = [
  { id: 'grau', name: 'Grau', hint: 'Nachtblau und Gold' },
  { id: 'feldgrau', name: 'Feldgrau', hint: 'Oliv und Khaki' },
  { id: 'pink', name: 'Pink', hint: 'Magenta und Violett' },
  { id: 'hell', name: 'Hell', hint: 'Heller Arbeitsplatz' },
];

const DEFAULTS: Settings = {
  theme: 'grau',
  accentHue: null,
  density: 'comfortable',
  glass: 0.55,
  motion: 'auto',
  sidebarCollapsed: false,
  favorites: [],
  recents: [],
  characterId: null,
  characterName: null,
  countryId: GERMANY_ID,
  notifyLive: false,
};

function initialSettings(): Settings {
  const stored = load<Partial<Settings> | null>('settings', null);
  if (stored) return { ...DEFAULTS, ...stored };
  // Erster Start: Theme der alten Oberfläche übernehmen
  const legacyTheme = loadLegacy('wl-theme');
  return { ...DEFAULTS, theme: legacyTheme === 'pink' ? 'pink' : 'grau' };
}

export const settings = signal<Settings>(initialSettings());

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

effect(() => save('settings', settings.value));

export function toggleFavorite(id: string): void {
  const favs = settings.value.favorites;
  updateSettings({ favorites: favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id] });
}

export function pushRecent(id: string): void {
  const next = [id, ...settings.value.recents.filter((r) => r !== id)].slice(0, 8);
  updateSettings({ recents: next });
}

// ---------- flüchtiger UI-Zustand ----------

export const paletteOpen = signal(false);
export const settingsOpen = signal(false);
export const helpOpen = signal(false);
export const mobileSidebarOpen = signal(false);

const mobileQuery = typeof window !== 'undefined' ? window.matchMedia('(max-width: 760px)') : null;
export const isMobile = signal(mobileQuery?.matches ?? false);
mobileQuery?.addEventListener('change', (e) => (isMobile.value = e.matches));

const reducedQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
export const systemReducedMotion = signal(reducedQuery?.matches ?? false);
reducedQuery?.addEventListener('change', (e) => (systemReducedMotion.value = e.matches));

export function motionEnabled(): boolean {
  const pref = settings.value.motion;
  if (pref === 'off') return false;
  if (pref === 'reduced') return false;
  return !systemReducedMotion.value;
}

// ---------- Toasts ----------

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'warn' | 'live';
  action?: { label: string; run: () => void };
}

export const toasts = signal<Toast[]>([]);
let toastSeq = 0;

export function toast(message: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ttlMs = 4500): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, message, kind, action }].slice(-4);
  window.setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
