import type { Tool } from '../data/tools';
import { Icon } from './icons';

/** Öffnet ein Tool als eigenes, schlankes Browserfenster neben dem Launcher. */
export function openAsWindow(tool: Pick<Tool, 'url' | 'id'>): void {
  const width = Math.min(1280, Math.round(window.screen.availWidth * 0.6));
  const height = Math.min(900, Math.round(window.screen.availHeight * 0.85));
  const left = Math.max(0, window.screen.availWidth - width - 24);
  const w = window.open(tool.url, `warera-${tool.id}`, `popup=yes,width=${width},height=${height},left=${left},top=40`);
  if (!w) window.open(tool.url, '_blank', 'noopener');
}

export function ExternalCard({ tool }: { tool: Tool }) {
  const reason =
    tool.health === 'dead'
      ? 'Die Seite antwortet derzeit nicht (zuletzt als offline gemeldet).'
      : `${hostOf(tool.url)} erlaubt keine Einbettung in andere Seiten. Öffne das Tool deshalb als eigenes Fenster oder im neuen Tab.`;
  return (
    <div class="external">
      <div class="external__emoji" aria-hidden="true">
        {tool.emoji}
      </div>
      <h3>{tool.name}</h3>
      {tool.desc && <p class="external__desc">{tool.desc}</p>}
      <p class="external__reason">{reason}</p>
      <div class="external__actions">
        <button type="button" class="btn btn--primary" onClick={() => openAsWindow(tool)}>
          <Icon name="float" />
          <span>Als Fenster öffnen</span>
        </button>
        <a class="btn btn--ghost" href={tool.url} target="_blank" rel="noopener">
          <Icon name="external" />
          <span>Neuer Tab</span>
        </a>
      </div>
    </div>
  );
}

export function MissingCard({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <div class="external external--missing">
      <div class="external__emoji" aria-hidden="true">
        🧩
      </div>
      <h3>Tool nicht mehr verfügbar</h3>
      <p class="external__reason">
        „{id}“ steht nicht mehr in der Tool-Liste. Vermutlich wurde es umbenannt oder entfernt.
      </p>
      <div class="external__actions">
        <button type="button" class="btn btn--ghost" onClick={onClose}>
          <Icon name="x" />
          <span>Panel schließen</span>
        </button>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Die Seite';
  }
}
