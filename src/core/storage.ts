// Sicherer Zugriff auf localStorage: blockierter Speicher (private Fenster, Richtlinien)
// darf die Seite nie lahmlegen. Alle neuen Schlüssel liegen unter dem Präfix "wl2:".

const PREFIX = 'wl2:';

function raw(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function load<T>(key: string, fallback: T): T {
  try {
    const value = raw()?.getItem(PREFIX + key);
    if (value == null) return fallback;
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    raw()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* Speicher voll oder gesperrt: bewusst ignoriert */
  }
}

export function remove(key: string): void {
  try {
    raw()?.removeItem(PREFIX + key);
  } catch {
    /* ignoriert */
  }
}

/** Liest einen Schlüssel der alten Oberfläche (ohne Präfix, Rohwert). */
export function loadLegacy(key: string): string | null {
  try {
    return raw()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Alle eigenen Einträge, z. B. für den Export der Einstellungen. */
export function dumpAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const store = raw();
  if (!store) return out;
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    try {
      out[k.slice(PREFIX.length)] = JSON.parse(store.getItem(k) ?? 'null');
    } catch {
      /* defekter Eintrag wird übersprungen */
    }
  }
  return out;
}

export function restoreAll(data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) save(k, v);
}

export function clearAll(): void {
  const store = raw();
  if (!store) return;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(PREFIX)) keys.push(k);
  }
  keys.forEach((k) => store.removeItem(k));
}

/** Bittet den Browser, die gespeicherten Layouts nicht automatisch zu verwerfen. */
export function requestPersistence(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* nicht unterstützt */
  }
}
