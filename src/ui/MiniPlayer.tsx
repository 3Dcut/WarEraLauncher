// Mini-Player im Document-Picture-in-Picture-Fenster: bleibt über dem Spiel-Tab im Vordergrund.
// Unterstützt in Chromium-Browsern und Firefox ab 151 (Desktop); sonst ist der Knopf ausgeblendet.

import { render } from 'preact';
import { signal } from '@preact/signals';
import { gameDates } from '../warera/dates';
import { formatCountdown } from '../core/clock';
import { STATIONS } from '../radio/stations';
import * as radio from '../radio/engine';
import { registerThemedDocument } from '../theme';
import { PlayButton, NowPlayingText, VolumeSlider, StationDot } from './RadioConsole';
import { useNow } from './primitives';
import { toast } from '../state';

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

const dpip = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;

export const pipSupported = !!dpip;
export const pipOpen = signal(false);

function MiniPlayer() {
  const now = useNow(1000);
  const dates = gameDates.value;
  return (
    <div class="mini">
      <div class="mini__row">
        <PlayButton size="md" />
        <NowPlayingText />
      </div>
      <div class="mini__stations">
        {STATIONS.map((s) => (
          <button type="button" data-radio-control class={`chip ${radio.station.value === s.id && radio.isPlaying.value ? 'chip--active' : ''}`} onClick={() => radio.play(s.id, { user: true })}>
            <StationDot id={s.id} /> {s.name}
          </button>
        ))}
      </div>
      <VolumeSlider id="mini-volume" />
      {dates && (
        <div class="mini__timers">
          <span>
            Regen <b class="mono">{formatCountdown(Date.parse(dates.nextRegenAt) - now)}</b>
          </span>
          <span>
            Tag <b class="mono">{formatCountdown(Date.parse(dates.nextDayAt) - now)}</b>
          </span>
        </div>
      )}
    </div>
  );
}

export async function openMiniPlayer(): Promise<void> {
  if (!dpip) return;
  if (dpip.window) {
    dpip.window.focus();
    return;
  }
  let pip: Window;
  try {
    pip = await dpip.requestWindow({ width: 360, height: 250 });
  } catch {
    toast('Der Browser hat den Mini-Player abgelehnt.', 'warn');
    return;
  }
  // Stylesheets übernehmen (im Build <link>, im Entwicklungsmodus <style>)
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    pip.document.head.appendChild(node.cloneNode(true));
  });
  pip.document.title = 'WarEra Mini-Player';
  pip.document.body.classList.add('pip-body');
  const unregister = registerThemedDocument(pip.document);
  const root = pip.document.createElement('div');
  pip.document.body.appendChild(root);
  render(<MiniPlayer />, root);
  pipOpen.value = true;
  pip.addEventListener('pagehide', () => {
    render(null, root);
    unregister();
    pipOpen.value = false;
  });
}
