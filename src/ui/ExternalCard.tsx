import type { Tool } from '../data/tools';
import { Icon } from './icons';
import { t } from '../i18n';

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
      ? t('shell.external.dead')
      : t('shell.external.noEmbed', { host: hostOf(tool.url) });
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
          <span>{t('shell.external.openWindow')}</span>
        </button>
        <a class="btn btn--ghost" href={tool.url} target="_blank" rel="noopener">
          <Icon name="external" />
          <span>{t('shell.external.newTab')}</span>
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
      <h3>{t('shell.external.missingTitle')}</h3>
      <p class="external__reason">
        {t('shell.external.missingText', { id })}
      </p>
      <div class="external__actions">
        <button type="button" class="btn btn--ghost" onClick={onClose}>
          <Icon name="x" />
          <span>{t('shell.external.closePanel')}</span>
        </button>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return t('shell.external.hostFallback');
  }
}
