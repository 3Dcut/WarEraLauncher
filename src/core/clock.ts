// Zeitfunktionen. Sendepläne (radio_schedule.json, audio_schedule.json) sind in deutscher Zeit
// geschrieben, deshalb rechnet der Launcher sie unabhängig von der Zeitzone des Rechners in Europe/Berlin.

export const TIME_ZONE = 'Europe/Berlin';

export interface ClockParts {
  dateKey: string; // YYYY-MM-DD
  timeKey: string; // HH:MM
  hours: number;
  minutes: number;
  minuteOfDay: number;
}

const partsFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function berlinParts(date: Date = new Date()): ClockParts {
  const parts: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) parts[p.type] = p.value;
  const hours = Number(parts.hour) % 24;
  const minutes = Number(parts.minute);
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    timeKey: `${hh}:${mm}`,
    hours,
    minutes,
    minuteOfDay: hours * 60 + minutes,
  };
}

/** "HH:MM" → Minuten seit Mitternacht; ungültige Angaben ergeben NaN. */
export function parseTimeKey(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minuteToTimeKey(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Wandelt laut.fm-Zeitstempel wie "2026-04-06 16:56:53 +0200" in ein Date. */
export function parseLautTime(value: string | undefined | null): Date | null {
  if (!value) return null;
  const iso = value.trim().replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Countdown kompakt: "2 T 04 h", "3:12 h", "12:05". */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} T ${String(hours).padStart(2, '0')} h`;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')} h`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const clockFormatter = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayClockFormatter = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Uhrzeit in der Zeitzone des Nutzers, bei anderem Tag mit Datum. */
export function formatClock(date: Date, now: Date = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? clockFormatter.format(date) : dayClockFormatter.format(date);
}
