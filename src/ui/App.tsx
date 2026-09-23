import { useEffect, useRef } from 'preact/hooks';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { SettingsDialog } from './SettingsDialog';
import { HelpDialog, Toasts } from './Overlays';
import { mountStage, rebuildAllDocks } from '../workspace/dock';
import { isMobile, mobileSidebarOpen, settings } from '../state';
import type { LayoutNode } from '../workspace/model';

export function App({ legacyTree }: { legacyTree: LayoutNode | null }) {
  const stage = useRef<HTMLDivElement>(null);
  const firstMobile = useRef(isMobile.value);

  useEffect(() => {
    if (stage.current) mountStage(stage.current, legacyTree);
  }, []);

  // Wechsel zwischen Handy- und Desktop-Breite: Layouts getrennt halten und neu aufbauen
  useEffect(() => {
    if (isMobile.value === firstMobile.current) return;
    firstMobile.current = isMobile.value;
    rebuildAllDocks();
  }, [isMobile.value]);

  const collapsed = settings.value.sidebarCollapsed && !isMobile.value;
  return (
    <div class={`app ${collapsed ? 'app--rail' : ''} ${isMobile.value ? 'app--mobile' : ''}`}>
      <TopBar />
      <div class="app__body">
        <Sidebar />
        {isMobile.value && mobileSidebarOpen.value && <div class="scrim" onClick={() => (mobileSidebarOpen.value = false)} />}
        <main class="stage" ref={stage} aria-label="Arbeitsfläche" />
      </div>
      <CommandPalette />
      <SettingsDialog />
      <HelpDialog />
      <Toasts />
    </div>
  );
}
