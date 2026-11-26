// Start eines Senders über einen Kurzlink (warera.de/r, /n, /a leiten auf ?radio=… weiter).
// Sperrt der Browser den Ton bis zur ersten Nutzeraktion, zeigt die Oberfläche einen Startknopf.

import { signal, effect } from '@preact/signals';
import { play, phase } from './engine';
import { stationFromAlias, type StationId } from './stations';
import { toast } from '../state';
import { t } from '../i18n';

/** Sender, den ein Kurzlink angefordert hat und der noch auf den Start wartet. */
export const linkStation = signal<StationId | null>(null);

effect(() => {
  if (phase.value === 'playing' || phase.value === 'paused') linkStation.value = null;
});

export function startRadioFromLink(): void {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('radio');
  if (wanted === null) return;
  params.delete('radio');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  const id = stationFromAlias(wanted);
  if (!id) {
    toast(t('radio.link.unknown', { name: wanted }), 'warn');
    return;
  }
  linkStation.value = id;
  play(id, { user: true });
}
