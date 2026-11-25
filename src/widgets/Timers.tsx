import { gameDates } from '../warera/dates';
import { formatClock, formatCountdown } from '../core/clock';
import { useNow } from '../ui/primitives';
import { t, type MessageKey } from '../i18n';

const ROWS: { key: keyof NonNullable<typeof gameDates.value>; label: MessageKey; hint: MessageKey }[] = [
  { key: 'nextRegenAt', label: 'widgets.timers.regen', hint: 'widgets.timers.regenHint' },
  { key: 'nextDayAt', label: 'widgets.timers.dayChange', hint: 'widgets.timers.dayChangeHint' },
  { key: 'dailyMissionRegenAt', label: 'widgets.timers.dailyMissions', hint: 'widgets.timers.missionsHint' },
  { key: 'weeklyMissionRegenAt', label: 'widgets.timers.weeklyMissions', hint: 'widgets.timers.missionsHint' },
  { key: 'monthlyMissionRegenAt', label: 'widgets.timers.monthlyMissions', hint: 'widgets.timers.missionsHint' },
  { key: 'nextPresidentialElectionsAt', label: 'widgets.timers.presidential', hint: 'widgets.timers.electionHint' },
  { key: 'nextCongressElectionsAt', label: 'widgets.timers.congress', hint: 'widgets.timers.electionHint' },
];

export function TimersWidget() {
  const now = useNow(1000);
  const dates = gameDates.value;
  if (!dates) return <div class="widget-empty">{t('widgets.timers.loading')}</div>;

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
          <span class="eyebrow">{t('widgets.timers.nextRegen')}</span>
          <div class="timers__big mono">{formatCountdown(regen - now)}</div>
          <span class="muted">{t('widgets.timers.regenAt', { time: formatClock(new Date(regen)) })}</span>
        </div>
      </div>
      <ul class="timer-list">
        {rows
          .filter((r) => r.key !== 'nextRegenAt')
          .map((r) => (
            <li class={`timer-row ${r.at - now < 3_600_000 ? 'is-soon' : ''}`}>
              <div>
                <strong>{t(r.label)}</strong>
                <small>{t(r.hint)}</small>
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
