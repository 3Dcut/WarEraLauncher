// Spielereignisse nach außen: als DOM-Ereignis im eigenen Fenster und, falls eingebettet, per
// postMessage an die Elternseite. Darauf kann später etwa Cardera aufsetzen (Wetten mit Gems),
// ohne dass das Battle selbst davon wissen muss. Es werden nur öffentliche Spieldaten verschickt.

export type BattleEventType = 'start' | 'open' | 'round' | 'finish';

export function emit(type: BattleEventType, detail: Record<string, unknown>): void {
  const payload = { source: 'warera-case-battle', version: 1, type, at: new Date().toISOString(), ...detail };
  try {
    window.dispatchEvent(new CustomEvent('case-battle', { detail: payload }));
    if (window.parent && window.parent !== window) window.parent.postMessage(payload, '*');
  } catch {
    /* Ereignisse sind optional */
  }
}
