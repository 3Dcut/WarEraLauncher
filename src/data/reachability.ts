// Prüft im Browser, ob die externen Tools gerade gültig erreichbar sind. Eine Anfrage im
// no-cors-Modus liefert zwar keinen Statuscode, scheitert aber zuverlässig bei DNS-Fehlern,
// abgelaufenen oder falschen Zertifikaten, Verbindungsabbrüchen und Zeitüberschreitungen.
// Statuscodes wie 404 und Einbettungsverbote liefert der wöchentliche Build-Check (tools-status.json).

import { signal } from '@preact/signals';
import { load, save } from '../core/storage';

export interface ProbeResult {
  ok: boolean;
  at: number;
}

export type ReachMap = Record<string, ProbeResult>;

const KEY = 'reach';
/** Erreichbare Seiten halbstündlich neu prüfen, nicht erreichbare öfter, damit sie schnell zurückkommen. */
const TTL_OK = 30 * 60_000;
const TTL_FAIL = 5 * 60_000;
const TIMEOUT = 10_000;

export const reachability = signal<ReachMap>(load<ReachMap>(KEY, {}));

export function isStale(entry: ProbeResult | undefined, now: number): boolean {
  if (!entry) return true;
  return now - entry.at > (entry.ok ? TTL_OK : TTL_FAIL);
}

/**
 * Übernimmt neue Prüfergebnisse. Scheitern alle Prüfungen einer Runde (ab drei Stück), liegt der
 * Fehler vermutlich beim eigenen Netz oder einem Blocker; dann bleibt der bisherige Stand erhalten.
 */
export function mergeProbeResults(previous: ReachMap, results: [string, ProbeResult][]): ReachMap | null {
  if (results.length === 0) return null;
  if (results.length >= 3 && results.every(([, r]) => !r.ok)) return null;
  return { ...previous, ...Object.fromEntries(results) };
}

async function probeOnce(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    await fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ein kurzer zweiter Versuch fängt einzelne Aussetzer ab, bevor ein Tool verschwindet. */
export async function probe(url: string): Promise<boolean> {
  if (await probeOnce(url)) return true;
  await new Promise((r) => setTimeout(r, 2_000));
  return probeOnce(url);
}

let running = false;

export async function probeAll(targets: { id: string; url: string }[]): Promise<void> {
  if (running || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  running = true;
  try {
    const now = Date.now();
    const due = targets.filter((t) => isStale(reachability.value[t.id], now));
    const results = await Promise.all(due.map(async (t) => [t.id, { ok: await probe(t.url), at: Date.now() }] as [string, ProbeResult]));
    const merged = mergeProbeResults(reachability.value, results);
    if (merged) {
      reachability.value = merged;
      save(KEY, merged);
    }
  } finally {
    running = false;
  }
}

let started = false;

/** Prüft beim Start und danach alle fünf Minuten die fälligen Tools, solange der Tab sichtbar ist. */
export function startReachabilityChecks(targets: () => { id: string; url: string }[]): void {
  if (started) return;
  started = true;
  void probeAll(targets());
  window.setInterval(() => {
    if (!document.hidden) void probeAll(targets());
  }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void probeAll(targets());
  });
}
