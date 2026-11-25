import { useEffect, useRef } from 'preact/hooks';
import { helpOpen, toasts, dismissToast } from '../state';
import { Dialog } from './primitives';
import { Icon } from './icons';
import type { ComponentChildren } from 'preact';
import { t, tx } from '../i18n';

function shortcuts(): [string[], string][] {
  return [
    [[t('settings.key.ctrl'), 'K'], t('settings.help.palette')],
    [['/'], t('settings.help.paletteSlash')],
    [['Alt', '1…9'], t('settings.help.workspace')],
    [['Alt', 'R'], t('settings.help.reload')],
    [['Alt', 'M'], t('settings.help.radio')],
    [['Alt', 'W'], t('settings.help.game')],
    [['Alt', 'T'], t('settings.help.theme')],
    [['Alt', 'B'], t('settings.help.sidebar')],
    [['?'], t('settings.help.overview')],
  ];
}

function tips(): ComponentChildren[] {
  return [
    t('settings.tip.drag'),
    t('settings.tip.tabs'),
    tx('settings.tip.float', { shift: t('settings.key.shift') }),
    t('settings.tip.context'),
    t('settings.tip.rename'),
    t('settings.tip.share'),
  ];
}

export function HelpDialog() {
  return (
    <Dialog open={helpOpen.value} onClose={() => (helpOpen.value = false)} title={t('settings.help.title')} icon="keyboard" class="help">
      <table class="shortcut-table">
        <tbody>
          {shortcuts().map(([keys, text]) => (
            <tr>
              <td>
                {keys.map((k, i) => (
                  <>
                    {i > 0 && ' + '}
                    <kbd>{k}</kbd>
                  </>
                ))}
              </td>
              <td>{text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>{t('settings.help.tips')}</h3>
      <ul class="tips">
        {tips().map((tip) => (
          <li>{tip}</li>
        ))}
      </ul>
    </Dialog>
  );
}

export function Toasts() {
  const ref = useRef<HTMLDivElement>(null);
  const list = toasts.value;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== 'function') return;
    // Im Top-Layer liegen Hinweise auch über Dialogen und Dockview-Overlays
    if (list.length && !el.matches(':popover-open')) el.showPopover();
    if (!list.length && el.matches(':popover-open')) el.hidePopover();
  }, [list.length]);

  return (
    <div ref={ref} popover="manual" class="toasts" role="status" aria-live="polite">
      {list.map((n) => (
        <div class={`toast toast--${n.kind}`} key={n.id}>
          <Icon name={n.kind === 'warn' ? 'warning' : n.kind === 'success' ? 'check' : n.kind === 'live' ? 'antenna' : 'info'} />
          <span class="toast__msg">{n.message}</span>
          {n.action && (
            <button
              type="button"
              class="btn btn--sm btn--primary"
              onClick={() => {
                n.action!.run();
                dismissToast(n.id);
              }}
            >
              {n.action.label}
            </button>
          )}
          <button type="button" class="icon-btn icon-btn--sm" aria-label={t('settings.toastClose')} onClick={() => dismissToast(n.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
