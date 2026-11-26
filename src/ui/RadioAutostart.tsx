import * as radio from '../radio/engine';
import { linkStation } from '../radio/link';
import { getStation } from '../radio/stations';
import { Icon } from './icons';
import { t } from '../i18n';

/** Großer Startknopf, wenn ein Kurzlink das Radio starten will, der Browser aber erst einen Klick verlangt. */
export function RadioAutostart() {
  const id = linkStation.value;
  if (!id || radio.phase.value !== 'blocked') return null;
  const station = getStation(id);
  return (
    <div class="autostart" role="dialog" aria-modal="true" aria-labelledby="autostart-title">
      <div class="autostart__card">
        <span class="autostart__emoji" aria-hidden="true">
          {station?.emoji ?? '📻'}
        </span>
        <h2 id="autostart-title">{station?.name ?? t('radio.console.fallbackName')}</h2>
        <p class="muted">{t('radio.autostart.hint')}</p>
        <button type="button" data-radio-control class="autostart__play" onClick={() => radio.toggle()} aria-label={t('radio.autostart.start', { name: station?.name ?? t('radio.console.fallbackName') })} autofocus>
          <Icon name="play" size={34} />
        </button>
        <button
          type="button"
          data-radio-control
          class="link-btn"
          onClick={() => {
            linkStation.value = null;
            radio.pause({ user: true });
          }}
        >
          {t('radio.autostart.later')}
        </button>
      </div>
    </div>
  );
}
