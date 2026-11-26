// Einstellungen des Battles und der API-Schlüssel. Der Schlüssel liegt bewusst nicht unter dem
// Präfix "wl2:", damit er beim Export der Launcher-Einstellungen nicht mitwandert.

export interface BattlePrefs {
  names: [string, string];
  caseCode: string | null;
  target: number;
  rate: number;
  sound: boolean;
  remember: boolean;
}

const PREFS_KEY = 'wb:prefs';
const KEY_KEY = 'wb:apiKey';

export const RATES = [1, 2, 4, 8] as const;

const DEFAULTS: BattlePrefs = { names: ['', ''], caseCode: 'case2', target: 3, rate: 8, sound: true, remember: true };

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadPrefs(): BattlePrefs {
  try {
    const stored = JSON.parse(storage('local')?.getItem(PREFS_KEY) ?? 'null') as Partial<BattlePrefs> | null;
    const p = { ...DEFAULTS, ...(stored ?? {}) };
    if (!Array.isArray(p.names) || p.names.length !== 2) p.names = ['', ''];
    p.target = clampTarget(p.target);
    if (!(RATES as readonly number[]).includes(p.rate)) p.rate = DEFAULTS.rate;
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: BattlePrefs): void {
  try {
    storage('local')?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignoriert */
  }
}

export function clampTarget(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(9, Math.max(1, n)) : 3;
}

export function loadKey(): string {
  return storage('local')?.getItem(KEY_KEY) ?? storage('session')?.getItem(KEY_KEY) ?? '';
}

/** Merken = localStorage, sonst nur für diesen Tab (sessionStorage). */
export function saveKey(key: string, remember: boolean): void {
  try {
    storage('local')?.removeItem(KEY_KEY);
    storage('session')?.removeItem(KEY_KEY);
    if (!key) return;
    storage(remember ? 'local' : 'session')?.setItem(KEY_KEY, key);
  } catch {
    /* ignoriert */
  }
}
