import { paletteOpen, helpOpen, settings, updateSettings } from './state';
import { activeDock, switchWorkspace } from './workspace/dock';
import { workspaces } from './workspace/model';
import { GAME_TOOL } from './data/tools';
import * as radio from './radio/engine';
import { cycleTheme } from './theme';
import { openAsWindow } from './ui/ExternalCard';

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function initShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      paletteOpen.value = !paletteOpen.value;
      return;
    }
    if (document.querySelector('dialog[open]')) return;

    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const ws = workspaces.value[Number(digit[1]) - 1];
        if (ws) {
          e.preventDefault();
          switchWorkspace(ws.id);
        }
        return;
      }
      const actions: Record<string, () => void> = {
        KeyR: () => activeDock()?.reloadActive(),
        KeyM: () => radio.toggle(),
        KeyW: () => openAsWindow(GAME_TOOL),
        KeyT: () => cycleTheme(),
        KeyB: () => updateSettings({ sidebarCollapsed: !settings.value.sidebarCollapsed }),
      };
      const run = actions[e.code];
      if (run) {
        e.preventDefault();
        run();
      }
      return;
    }

    if (typing(e.target) || e.ctrlKey || e.metaKey) return;
    if (e.key === '/') {
      e.preventDefault();
      paletteOpen.value = true;
    } else if (e.key === '?') {
      e.preventDefault();
      helpOpen.value = true;
    }
  });
}
