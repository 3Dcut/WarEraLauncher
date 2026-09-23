import { signal } from '@preact/signals';
import { getDates, type GameDates } from './api';

export const gameDates = signal<GameDates | null>(null);
let lastFetch = 0;
let started = false;

async function refresh(): Promise<void> {
  try {
    gameDates.value = await getDates();
    lastFetch = Date.now();
  } catch (err) {
    console.warn('Spielzeiten nicht verfügbar', err);
  }
}

/** Holt die Spielzeiten beim Start, nach jeder Regeneration und spätestens alle 10 Minuten. */
export function startGameDates(): void {
  if (started) return;
  started = true;
  void refresh();
  window.setInterval(() => {
    const regen = gameDates.value ? Date.parse(gameDates.value.nextRegenAt) : 0;
    const stale = Date.now() - lastFetch > 10 * 60_000;
    if (!document.hidden && (stale || (regen && Date.now() > regen + 5_000))) void refresh();
  }, 20_000);
}

const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['de'], { type: 'region' }) : null;

/** Ländername auf Deutsch anhand des ISO-Codes, sonst der Name aus der API. */
export function countryName(code: string | undefined, fallback: string): string {
  if (!code || !regionNames) return fallback;
  try {
    return regionNames.of(code.toUpperCase()) ?? fallback;
  } catch {
    return fallback;
  }
}
