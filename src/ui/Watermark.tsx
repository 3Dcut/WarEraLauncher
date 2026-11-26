import type { DockviewApi } from 'dockview';
import { presets, workspaces, treeIds, workspaceLabel } from '../workspace/model';
import { activeDock, openLaunchable } from '../workspace/dock';
import { WIDGETS, findLaunchable } from '../data/tools';
import { paletteOpen } from '../state';
import { Icon } from './icons';
import { t, tx } from '../i18n';

/** Startansicht eines leeren Arbeitsbereichs. */
export function Watermark({ workspaceId }: { workspaceId: string; api: DockviewApi }) {
  const ws = workspaces.value.find((w) => w.id === workspaceId);
  return (
    <div class="watermark">
      <div class="watermark__head">
        <span class="eyebrow">
          {ws?.icon} {ws ? workspaceLabel(ws) : t('shell.watermark.workspace')}
        </span>
        <h2>{t('shell.watermark.heading')}</h2>
        <p>
          {tx('shell.watermark.text', {
            keys: (
              <>
                <kbd>{t('shell.watermark.ctrl')}</kbd> + <kbd>K</kbd>
              </>
            ),
          })}
        </p>
      </div>

      <section class="watermark__section" aria-label={t('shell.watermark.presets')}>
        <h3>{t('shell.watermark.presets')}</h3>
        <div class="preset-grid">
          {presets.value.map((p) => (
            <button type="button" class="preset-card" onClick={() => activeDock()?.applyTree(p.layout)}>
              <span class="preset-card__icon" aria-hidden="true">
                {p.icon}
              </span>
              <span class="preset-card__name">{p.name}</span>
              <span class="preset-card__items">
                {treeIds(p.layout)
                  .map((id) => findLaunchable(id)?.name)
                  .filter(Boolean)
                  .slice(0, 4)
                  .join(' · ')}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section class="watermark__section" aria-label={t('shell.watermark.widgets')}>
        <h3>{t('shell.watermark.liveWidgets')}</h3>
        <div class="chip-row">
          {WIDGETS.map((w) => (
            <button type="button" class="chip" onClick={() => openLaunchable(w.id)}>
              <span aria-hidden="true">{w.emoji}</span> {w.name}
            </button>
          ))}
          <button type="button" class="chip chip--accent" onClick={() => (paletteOpen.value = true)}>
            <Icon name="search" size={14} /> {t('shell.watermark.searchAll')}
          </button>
        </div>
      </section>
    </div>
  );
}
