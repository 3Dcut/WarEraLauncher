import { gameDates } from '../warera/dates';
import { formatClock, formatCountdown } from '../core/clock';
import { useNow } from '../ui/primitives';

const ROWS: { key: keyof NonNullable<typeof gameDates.value>; label: string; hint: string }[] = [
  { key: 'nextRegenAt', label: 'Regeneration', hint: 'Energie, Gesundheit, Hunger +10 %' },
  { key: 'nextDayAt', label: 'Tageswechsel', hint: 'Neuer Spieltag' },
  { key: 'dailyMissionRegenAt', label: 'Tagesmissionen', hint: 'Neue Missionen' },
  { key: 'weeklyMissionRegenAt', label: 'Wochenmissionen', hint: 'Neue Missionen' },
  { key: 'monthlyMissionRegenAt', label: 'Monatsmissionen', hint: 'Neue Missionen' },
  { key: 'nextPresidentialElectionsAt', label: 'Präsidentschaftswahl', hint: 'Nächster Wahltermin' },
  { key: 'nextCongressElectionsAt', label: 'Kongresswahl', hint: 'Nächster Wahltermin' },
];

export function TimersWidget() {
  const now = useNow(1000);
  const dates = gameDates.value;
  if (!dates) return <div class="widget-empty">Spielzeiten werden geladen …</div>;

  const regen = Date.parse(dates.nextRegenAt);
  const hourProgress = 1 - Math.max(0, regen - now) / 3_600_000;

  const rows = ROWS.map((r) => ({ ...r, at: dates[r.key] ? Date.parse(dates[r.key] as string) : NaN }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);

  return (
    <div class="timers">
      <div class="timers__hero">
        <div class="ring" style={{ '--p': Math.min(1, Math.max(0, hourProgress)) }} aria-hidden="true" />
        <div>
          <span class="eyebrow">Nächste Regeneration</span>
          <div class="timers__big mono">{formatCountdown(regen - now)}</div>
          <span class="muted">um {formatClock(new Date(regen))} Uhr · jede volle Stunde</span>
        </div>
      </div>
      <ul class="timer-list">
        {rows
          .filter((r) => r.key !== 'nextRegenAt')
          .map((r) => (
            <li class={`timer-row ${r.at - now < 3_600_000 ? 'is-soon' : ''}`}>
              <div>
                <strong>{r.label}</strong>
                <small>{r.hint}</small>
              </div>
              <div class="timer-row__value">
                <span class="mono">{formatCountdown(r.at - now)}</span>
                <small>{formatClock(new Date(r.at), new Date(now))}</small>
              </div>
            </li>
          ))}
      </ul>
    </div>
  );
}
