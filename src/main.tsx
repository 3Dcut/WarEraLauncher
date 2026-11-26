// Zuerst: Sprache festlegen, bevor andere Module Texte oder Einstellungen anlegen
import { initDocumentLanguage, t } from './i18n';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource-variable/quicksand';
import '@fontsource-variable/source-code-pro';
import 'dockview/dist/styles/dockview.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/dock.css';
import './styles/widgets.css';

import { render } from 'preact';
import { App } from './ui/App';
import { loadTools, allTools } from './data/tools';
import { startReachabilityChecks } from './data/reachability';
import { loadPresets, ensureWorkspaces, decodeShare, addWorkspace, newId } from './workspace/model';
import { queueTree, switchWorkspace } from './workspace/dock';
import { initTheme } from './theme';
import { initRadio } from './radio/engine';
import { startRadioFromLink } from './radio/link';
import { initApiKeyBridge } from './ui/ApiKeyBridge';
import { startGameDates } from './warera/dates';
import { initShortcuts } from './shortcuts';
import { toast } from './state';

async function importSharedWorkspace(): Promise<string | null> {
  const match = /^#ws=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  const shared = await decodeShare(match[1]);
  if (!shared) {
    toast(t('settings.shareInvalid'), 'warn');
    return null;
  }
  const id = newId();
  queueTree(id, shared.l);
  addWorkspace({ id, name: shared.n, icon: shared.i });
  toast(t('settings.shareAdded', { name: shared.n }), 'success');
  return id;
}

async function start(): Promise<void> {
  initDocumentLanguage();
  initTheme();
  const [, defaults] = await Promise.all([loadTools(), loadPresets()]);
  const { legacyTree } = ensureWorkspaces(defaults);
  await importSharedWorkspace();

  const root = document.getElementById('app')!;
  root.textContent = '';
  render(<App legacyTree={legacyTree} />, root);

  startReachabilityChecks(() => allTools.value.filter((t) => !t.hidden).map((t) => ({ id: t.id, url: t.url })));
  initRadio();
  // Kurzlinks warera.de/r, /n, /a starten direkt einen Sender
  startRadioFromLink();
  // Eingebettete Tools dürfen den API-Schlüssel nach Freigabe anfragen
  initApiKeyBridge();
  startGameDates();
  initShortcuts();
  // Link eingefügt, während der Launcher schon offen ist
  window.addEventListener('hashchange', () => {
    void importSharedWorkspace().then((id) => id && switchWorkspace(id));
  });
}

void start();
