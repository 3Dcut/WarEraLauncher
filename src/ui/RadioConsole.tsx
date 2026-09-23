import { STATIONS, getStation, type StationId } from '../radio/stations';
import { levelOf, type StationLevel } from '../radio/logic';
import * as radio from '../radio/engine';
import { Icon } from './icons';
import { Switch } from './primitives';

export const LEVEL_LABEL: Record<StationId, Record<StationLevel, string>> = {
  'war-era-de': { force: 'FORCE', live: 'Live', online: 'Live', offline: 'AutoDJ' },
  'warera-nachtwache': { force: 'FORCE', live: 'Live', online: 'Live', offline: 'AutoDJ' },
  'warera-azura': { force: 'Live-DJ', live: 'Live-DJ', online: 'Online', offline: 'Offline' },
};

export function phaseLabel(): string {
  switch (radio.phase.value) {
    case 'connecting':
      return 'Verbinde …';
    case 'reconnecting':
      return 'Verbindung wird erneuert …';
    case 'blocked':
      return 'Tippen zum Starten';
    case 'paused':
      return 'Pausiert';
    case 'playing':
      return radio.activeClip.value ? 'Einspieler läuft' : 'Läuft';
    default:
      return 'Aus';
  }
}

export function StationDot({ id }: { id: StationId }) {
  const level = levelOf(radio.status.value, id);
  return <span class={`dot dot--${level}`} title={LEVEL_LABEL[id][level]} aria-hidden="true" />;
}

export function PlayButton({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const playing = radio.isPlaying.value;
  const label = playing ? 'Radio pausieren' : radio.phase.value === 'blocked' ? 'Radio starten' : 'Radio abspielen';
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
        aria-label="Lautstärke"
        onInput={(e) => radio.setVolume(Number((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

export function NowPlayingText() {
  const clip = radio.activeClip.value;
  const np = radio.nowPlaying.value;
  const waiting = radio.waitingClip.value;
  const title = clip ? `🎙 Einspieler: ${clip}` : np?.title || (radio.isPlaying.value ? 'Titel wird geladen …' : 'Kein Stream aktiv');
  return (
    <div class="np">
      <div class="np__title" title={title}>
        <span>{title}</span>
      </div>
      <div class="np__meta">
        <span>{phaseLabel()}</span>
        {np?.listeners && !clip && <span>🎧 {np.listeners} Sparschäler</span>}
        {waiting && <span>⏳ „{waiting}“ nach diesem Song</span>}
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
            {current ? `${current.emoji} ${current.name}` : 'WarEra Radio'}
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
                {LEVEL_LABEL[s.id][level]}
              </span>
              <Icon name={active ? 'pause' : 'play'} size={14} />
            </button>
          );
        })}
      </div>

      <div class="radio-console__auto">
        <Switch id={`${idPrefix}-auto`} checked={radio.autoMode.value} onChange={(v) => radio.setAuto(v)} label="Automatik" hint="Folgt Live-DJs, FORCE und dem Sendeplan" />
        {radio.autoMode.value && radio.autoReason.value && <p class="auto-reason">Gewählt, weil: {radio.autoReason.value}</p>}
      </div>

      {!compact && (
        <div class="radio-console__plan">
          <h4>Nächste Einspieler</h4>
          {upcoming.length === 0 && <p class="muted">Heute nichts mehr geplant.</p>}
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
          <summary>Stream streikt?</summary>
          <p>Öffne die Senderseite direkt. Dort läuft der Player des Anbieters.</p>
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
