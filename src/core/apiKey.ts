// Persönlicher WarEra-API-Schlüssel, einmal im Launcher hinterlegt und von den Tools mitgenutzt.
//
// - Eigene Seiten unter warera.de (Kisten-Battle usw.) haben dieselbe Herkunft und lesen ihn direkt.
// - Eingebettete fremde Tools können ihn per postMessage anfragen; der Launcher gibt ihn nur an
//   Herkünfte heraus, die der Nutzer freigegeben hat (siehe ui/ApiKeyBridge.tsx).
// Der Schlüssel liegt bewusst nicht unter "wl2:", damit er beim Export der Einstellungen nicht in
// einer Datei landet, die man vielleicht weitergibt.

import { signal } from '@preact/signals';

const KEY = 'warera:apiKey';
const DECISIONS = 'warera:apiKeyOrigins';
/** Vorläufer aus der ersten Fassung des Kisten-Battles. */
const LEGACY = 'wb:apiKey';

export type OriginDecision = 'allow' | 'deny';

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(): string {
  const s = store();
  if (!s) return '';
  try {
    const current = s.getItem(KEY);
    if (current) return current;
    const legacy = s.getItem(LEGACY) ?? window.sessionStorage?.getItem(LEGACY) ?? '';
    if (legacy) {
      s.setItem(KEY, legacy);
      s.removeItem(LEGACY);
      window.sessionStorage?.removeItem(LEGACY);
    }
    return legacy;
  } catch {
    return '';
  }
}

/** Aktueller Schlüssel ('' = keiner); folgt Änderungen aus anderen Tabs und Fenstern. */
export const apiKey = signal<string>(read());

export function setApiKey(value: string): void {
  const key = value.trim();
  try {
    if (key) store()?.setItem(KEY, key);
    else store()?.removeItem(KEY);
  } catch {
    /* gesperrter Speicher: gilt dann nur bis zum Neuladen */
  }
  apiKey.value = key;
}

function readDecisions(): Record<string, OriginDecision> {
  try {
    const parsed = JSON.parse(store()?.getItem(DECISIONS) ?? '{}') as Record<string, OriginDecision>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Entscheidungen je Herkunft (https://tool.example), ob ein eingebettetes Tool den Schlüssel bekommt. */
export const originDecisions = signal<Record<string, OriginDecision>>(readDecisions());

export function decideOrigin(origin: string, decision: OriginDecision | null): void {
  const next = { ...originDecisions.value };
  if (decision) next[origin] = decision;
  else delete next[origin];
  originDecisions.value = next;
  try {
    store()?.setItem(DECISIONS, JSON.stringify(next));
  } catch {
    /* ignoriert */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === KEY) apiKey.value = read();
    if (e.key === null || e.key === DECISIONS) originDecisions.value = readDecisions();
  });
}

/** Schlüssel und alle Freigaben löschen, etwa beim Zurücksetzen des Launchers. */
export function forgetApiKeyData(): void {
  setApiKey('');
  originDecisions.value = {};
  try {
    store()?.removeItem(DECISIONS);
  } catch {
    /* ignoriert */
  }
}

/** Prüft einen Schlüssel mit der kleinstmöglichen Abfrage, die einen Schlüssel verlangt. */
export async function verifyApiKey(key: string): Promise<'ok' | 'invalid' | 'error'> {
  const input = encodeURIComponent(JSON.stringify({ 0: { limit: 1, transactionType: 'openCase' } }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`https://api2.warera.io/trpc/transaction.getPaginatedTransactions?batch=1&input=${input}`, {
      headers: { 'X-API-Key': key.trim() },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return 'invalid';
    const body = (await res.json().catch(() => null)) as { error?: { data?: { httpStatus?: number } } }[] | null;
    const status = Array.isArray(body) ? body[0]?.error?.data?.httpStatus : undefined;
    if (status === 401 || status === 403) return 'invalid';
    return res.ok || res.status === 207 ? 'ok' : 'error';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}
