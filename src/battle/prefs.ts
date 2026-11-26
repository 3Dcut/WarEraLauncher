// Was sich das Battle merkt: die zuletzt eingetragenen Namen, Rot oder Grün und den Ton.
// Punkteziel (FT3) und Abfragetakt sind feste Regeln, der API-Schlüssel liegt im Launcher (core/apiKey).

export interface BattlePrefs {
  names: [string, string];
  caseCode: 'case2' | 'case1';
  sound: boolean;
}

const PREFS_KEY = 'wb:prefs';

const DEFAULTS: BattlePrefs = { names: ['', ''], caseCode: 'case2', sound: true };

export function loadPrefs(): BattlePrefs {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<BattlePrefs> | null;
    return {
      names: Array.isArray(stored?.names) && stored.names.length === 2 ? [String(stored.names[0] ?? ''), String(stored.names[1] ?? '')] : ['', ''],
      caseCode: stored?.caseCode === 'case1' ? 'case1' : 'case2',
      sound: stored?.sound !== false,
    };
  } catch {
    return { ...DEFAULTS, names: ['', ''] };
  }
}

export function savePrefs(p: BattlePrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignoriert */
  }
}
