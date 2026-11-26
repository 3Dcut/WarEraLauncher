import { STATIONS, getStation, type StationId } from '../radio/stations';
import { levelOf, type StationLevel, type AutoReason } from '../radio/logic';
import * as radio from '../radio/engine';
import { t } from '../i18n';
import { Icon } from './icons';
import { Switch } from './primitives';

export function levelLabel(id: StationId, level: StationLevel): string {
  if (id === 'warera-azura') {
    return level === 'force' || level === 'live' ? t('radio.level.liveDj') : level === 'online' ? t('radio.level.online') : t('radio.level.offline');
  }
  return level === 'force' ? 'FORCE' : level === 'offline' ? 'AutoDJ' : 'Live';
}

function autoReasonText(reason: AutoReason): string {
  return t(`radio.auto.${reason.code}`, { start: reason.start ?? '', end: reason.end ?? '' });
}

export function phaseLabel(): string {
  switch (radio.phase.value) {
    case 'connecting':
      return t('radio.phase.connecting');
    case 'reconnecting':
      return t('radio.phase.reconnecting');
    case 'blocked':
      return t('radio.phase.blocked');
    case 'paused':
      return t('radio.phase.paused');
    case 'playing':
      return radio.activeClip.value ? t('radio.phase.clip') : t('radio.phase.playing');
    default:
      return t('radio.phase.off');
  }
}

export function StationDot({ id }: { id: StationId }) {
  const level = levelOf(radio.status.value, id);
  return <span class={`dot dot--${level}`} title={levelLabel(id, level)} aria-hidden="true" />;
}

export function PlayButton({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const playing = radio.isPlaying.value;
  const label = playing ? t('radio.play.pause') : radio.phase.value === 'blocked' ? t('radio.play.start') : t('radio.play.play');
  return (
    <button type="button" data-radio-control class={`play-btn play-btn--${size} ${playing ? 'is-playing' : ''}`} onClick={() => radio.toggle()} aria-label={label} title={label}>
      <Icon name={playing ? 'pause' : 'play'} size={size === 'lg' ? 22 : size === 'sm' ? 14 : 18} />
    </button>
  );
}

export function VolumeSlider({ id }: { id: string }) {
  return (
    <label class="volume" for={id}>
      <Icon name={radio.volume.value === 0 ? 'mute' : 'volume'} />
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={radio.volume.value}
        aria-label={t('radio.volume')}
        onInput={(e) => radio.setVolume(Number((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

export function NowPlayingText() {
  const clip = radio.activeClip.value;
  const np = radio.nowPlaying.value;
  const waiting = radio.waitingClip.value;
  const title = clip ? t('radio.np.clip', { name: clip }) : np?.title || (radio.isPlaying.value ? t('radio.np.loading') : t('radio.np.none'));
  return (
    <div class="np">
      <div class="np__title" title={title}>
        <span>{title}</span>
      </div>
      <div class="np__meta">
        <span>{phaseLabel()}</span>
        {np?.listeners && !clip && <span>{t('radio.np.listeners', { count: np.listeners })}</span>}
        {waiting && <span>{t('radio.np.waiting', { name: waiting })}</span>}
      </div>
    </div>
  );
}

export function RadioConsole({ idPrefix, compact = false }: { idPrefix: string; compact?: boolean }) {
  const current = getStation(radio.station.value);
  const upcoming = radio.upcoming.value;
  return (
    <div class={`radio-console ${compact ? 'radio-console--compact' : ''}`}>
      <div class="radio-console__now">
        <PlayButton size="lg" />
        <div class="radio-console__station">
          <span class="eyebrow">
            {current ? `${current.emoji} ${current.name}` : t('radio.console.fallbackName')}
            {current && <StationDot id={current.id} />}
          </span>
          <NowPlayingText />
        </div>
      </div>

      <VolumeSlider id={`${idPrefix}-volume`} />

      <div class="station-list" role="list">
        {STATIONS.map((s) => {
          const level = levelOf(radio.status.value, s.id);
          const active = radio.station.value === s.id && radio.isPlaying.value;
          return (
            <button type="button" role="listitem" data-radio-control class={`station ${active ? 'is-active' : ''}`} onClick={() => (active ? radio.pause({ user: true }) : radio.play(s.id, { user: true }))} aria-pressed={active}>
              <span class="station__emoji" aria-hidden="true">
                {s.emoji}
              </span>
              <span class="station__name">{s.name}</span>
              <span class={`level level--${level}`}>
                <span class={`dot dot--${level}`} aria-hidden="true" />
                {levelLabel(s.id, level)}
              </span>
              <Icon name={active ? 'pause' : 'play'} size={14} />
            </button>
          );
        })}
      </div>

      <div class="radio-console__auto">
        <Switch id={`${idPrefix}-auto`} checked={radio.autoMode.value} onChange={(v) => radio.setAuto(v)} label={t('radio.auto.label')} hint={t('radio.auto.hint')} />
        {radio.autoMode.value && radio.autoReason.value && <p class="auto-reason">{t('radio.auto.reason', { reason: autoReasonText(radio.autoReason.value) })}</p>}
      </div>

      {!compact && (
        <div class="radio-console__plan">
          <h4>{t('radio.plan.title')}</h4>
          {upcoming.length === 0 && <p class="muted">{t('radio.plan.empty')}</p>}
          <ul>
            {upcoming.map((c) => (
              <li>
                <span class="mono">{c.time}</span>
                <span>{c.jingle ? `🔔 ${c.name}` : c.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && (
        <details class="radio-console__fallback">
          <summary>{t('radio.fallback.summary')}</summary>
          <p>{t('radio.fallback.text')}</p>
          <div class="chip-row">
            {STATIONS.map((s) => (
              <a class="chip" href={s.page} target="_blank" rel="noopener">
                {s.emoji} {s.name}
              </a>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
