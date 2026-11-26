// Gibt den WarEra-API-Schlüssel an eingebettete Tools weiter, wenn sie danach fragen.
//
// Protokoll (für Tool-Entwickler, auch im README):
//   Tool → Launcher:  window.parent.postMessage({ type: 'warera:api-key:request' }, '*')
//   Launcher → Tool:  { type: 'warera:api-key', key: string | null, reason?: 'denied' | 'missing' }
// Eigene Seiten unter derselben Herkunft bekommen ihn sofort, fremde erst nach einer Freigabe je
// Herkunft, die in den Einstellungen widerrufen werden kann. Ändert sich der Schlüssel, bekommen
// freigegebene, gerade geöffnete Tools den neuen Wert.

import { signal, effect } from '@preact/signals';
import { apiKey, originDecisions, decideOrigin } from '../core/apiKey';
import { allTools } from '../data/tools';
import { settingsOpen, toast } from '../state';
import { Dialog } from './primitives';
import { t } from '../i18n';

interface Pending {
  origin: string;
  tool: string;
  targets: MessageEventSource[];
}

const pending = signal<Pending | null>(null);

function reply(target: MessageEventSource, origin: string, key: string | null, reason?: 'denied' | 'missing'): void {
  try {
    (target as Window).postMessage({ type: 'warera:api-key', key, ...(reason ? { reason } : {}) }, origin);
  } catch {
    /* Fenster inzwischen geschlossen */
  }
}

function isOwnFrame(source: MessageEventSource | null): boolean {
  if (!source) return false;
  return [...document.querySelectorAll('iframe')].some((f) => f.contentWindow === source);
}

function toolNameFor(origin: string): string {
  const tool = allTools.value.find((tl) => {
    try {
      return new URL(tl.url).origin === origin;
    } catch {
      return false;
    }
  });
  return tool?.name ?? origin.replace(/^https?:\/\//, '');
}

function answer(source: MessageEventSource, origin: string): void {
  if (origin === location.origin) {
    reply(source, origin, apiKey.value || null, apiKey.value ? undefined : 'missing');
    return;
  }
  const decision = originDecisions.value[origin];
  if (decision === 'deny') {
    reply(source, origin, null, 'denied');
    return;
  }
  if (!apiKey.value) {
    reply(source, origin, null, 'missing');
    toast(t('shell.apiKey.missing', { tool: toolNameFor(origin) }), 'info', { label: t('shell.apiKey.openSettings'), run: () => (settingsOpen.value = true) }, 8000);
    return;
  }
  if (decision === 'allow') {
    reply(source, origin, apiKey.value);
    return;
  }
  // Noch nicht entschieden: einmal fragen, weitere Anfragen derselben Herkunft sammeln
  const current = pending.value;
  if (current?.origin === origin) {
    if (!current.targets.includes(source)) pending.value = { ...current, targets: [...current.targets, source] };
    return;
  }
  if (current) {
    reply(source, origin, null, 'denied');
    return;
  }
  pending.value = { origin, tool: toolNameFor(origin), targets: [source] };
}

function resolve(decision: 'allow' | 'deny'): void {
  const p = pending.value;
  if (!p) return;
  decideOrigin(p.origin, decision);
  for (const target of p.targets) reply(target, p.origin, decision === 'allow' ? apiKey.value : null, decision === 'allow' ? undefined : 'denied');
  pending.value = null;
}

let started = false;

export function initApiKeyBridge(): void {
  if (started) return;
  started = true;
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: unknown } | null;
    if (!data || data.type !== 'warera:api-key:request') return;
    if (!e.source || !isOwnFrame(e.source) || !e.origin || e.origin === 'null') return;
    answer(e.source, e.origin);
  });
  // Neuer Schlüssel: freigegebene, offene Tools bekommen ihn ohne neue Anfrage
  let first = true;
  effect(() => {
    const key = apiKey.value;
    const decisions = originDecisions.value;
    if (first) {
      first = false;
      return;
    }
    for (const frame of document.querySelectorAll('iframe')) {
      let origin = '';
      try {
        origin = new URL(frame.src, location.href).origin;
      } catch {
        continue;
      }
      if (origin !== location.origin && decisions[origin] !== 'allow') continue;
      if (frame.contentWindow) reply(frame.contentWindow, origin, key || null, key ? undefined : 'missing');
    }
  });
}

export function ApiKeyConsent() {
  const p = pending.value;
  return (
    <Dialog open={!!p} onClose={() => resolve('deny')} title={t('shell.apiKey.title')} icon="shield" class="dialog--narrow">
      {p && (
        <>
          <p>{t('shell.apiKey.body', { tool: p.tool, origin: p.origin })}</p>
          <div class="btn-row" style={{ marginTop: '14px' }}>
            <button type="button" class="btn btn--primary" onClick={() => resolve('allow')}>
              {t('shell.apiKey.allow')}
            </button>
            <button type="button" class="btn btn--ghost" onClick={() => resolve('deny')}>
              {t('shell.apiKey.deny')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
