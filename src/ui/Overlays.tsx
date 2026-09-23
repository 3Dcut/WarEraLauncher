import { useEffect, useRef } from 'preact/hooks';
import { helpOpen, toasts, dismissToast } from '../state';
import { Dialog } from './primitives';
import { Icon } from './icons';

const SHORTCUTS: [string[], string][] = [
  [['Strg', 'K'], 'Befehlspalette: Tools, Widgets, Sender, Aktionen'],
  [['/'], 'Befehlspalette (außerhalb von Eingabefeldern)'],
  [['Alt', '1…9'], 'Zum Arbeitsbereich 1 bis 9 wechseln'],
  [['Alt', 'R'], 'Aktives Tool neu laden'],
  [['Alt', 'M'], 'Radio an/aus'],
  [['Alt', 'W'], 'WarEra als Fenster öffnen'],
  [['Alt', 'T'], 'Theme wechseln'],
  [['Alt', 'B'], 'Seitenleiste ein-/ausklappen'],
  [['?'], 'Diese Übersicht'],
];

const TIPS: string[] = [
  'Tools aus der Seitenleiste auf eine Kante ziehen teilt die Fläche, auf die Mitte ziehen stapelt sie als Tab.',
  'Tabs lassen sich zwischen Fenstern verschieben; die eingebetteten Seiten laden dabei nicht neu.',
  'Mit Umschalt beim Ziehen eines Tabs oder über das Fenster-Symbol oben rechts wird ein Tool zum schwebenden Fenster.',
  'Rechtsklick auf einen Tab öffnet weitere Aktionen wie Neu laden oder Andere schließen.',
  'Doppelklick auf einen Arbeitsbereich benennt ihn um; per Drag & Drop lassen sich Arbeitsbereiche sortieren.',
  'Über das Menü eines Arbeitsbereichs teilst du dein Layout als Link, etwa im Discord.',
];

export function HelpDialog() {
  return (
    <Dialog open={helpOpen.value} onClose={() => (helpOpen.value = false)} title="Tastenkürzel & Tipps" icon="keyboard" class="help">
      <table class="shortcut-table">
        <tbody>
          {SHORTCUTS.map(([keys, text]) => (
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
      <h3>Tipps</h3>
      <ul class="tips">
        {TIPS.map((t) => (
          <li>{t}</li>
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
      {list.map((t) => (
        <div class={`toast toast--${t.kind}`} key={t.id}>
          <Icon name={t.kind === 'warn' ? 'warning' : t.kind === 'success' ? 'check' : t.kind === 'live' ? 'antenna' : 'info'} />
          <span class="toast__msg">{t.message}</span>
          {t.action && (
            <button
              type="button"
              class="btn btn--sm btn--primary"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" class="icon-btn icon-btn--sm" aria-label="Hinweis schließen" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
