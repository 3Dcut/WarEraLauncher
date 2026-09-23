import { effect } from '@preact/signals';
import { settings, updateSettings, systemReducedMotion, motionEnabled, THEMES, type ThemeId } from './state';
import { refreshDockThemes } from './workspace/dock';

/** Überträgt Einstellungen als data-Attribute und CSS-Variablen auf ein Dokument (Hauptfenster oder Mini-Player). */
export function applyThemeTo(doc: Document): void {
  const s = settings.value;
  const root = doc.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.dataset.motion = s.motion === 'auto' ? (systemReducedMotion.value ? 'reduced' : 'full') : s.motion === 'off' ? 'off' : 'reduced';
  root.style.setProperty('--glass', String(s.glass));
  if (s.accentHue == null) root.style.removeProperty('--accent-h');
  else root.style.setProperty('--accent-h', String(s.accentHue));
  root.style.colorScheme = s.theme === 'hell' ? 'light' : 'dark';
  const meta = doc.querySelector('meta[name="theme-color"]');
  const ground = getComputedStyle(root).getPropertyValue('--ground').trim();
  if (meta && ground) meta.setAttribute('content', ground);
}

const extraDocs = new Set<Document>();

export function registerThemedDocument(doc: Document): () => void {
  extraDocs.add(doc);
  applyThemeTo(doc);
  return () => extraDocs.delete(doc);
}

export function initTheme(): void {
  effect(() => {
    void settings.value;
    void systemReducedMotion.value;
    applyThemeTo(document);
    extraDocs.forEach(applyThemeTo);
    refreshDockThemes();
  });
}

/** Themewechsel mit kreisförmiger Enthüllung ab dem auslösenden Element. */
export function setTheme(theme: ThemeId, origin?: HTMLElement | null): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!motionEnabled() || !doc.startViewTransition) {
    updateSettings({ theme });
    return;
  }
  const rect = origin?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 40;
  const y = rect ? rect.top + rect.height / 2 : 24;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  document.documentElement.style.setProperty('--vt-x', `${x}px`);
  document.documentElement.style.setProperty('--vt-y', `${y}px`);
  document.documentElement.style.setProperty('--vt-r', `${radius}px`);
  document.documentElement.classList.add('vt-theme');
  const vt = doc.startViewTransition(() => updateSettings({ theme }));
  void vt.ready.finally(() => window.setTimeout(() => document.documentElement.classList.remove('vt-theme'), 600));
}

export function cycleTheme(origin?: HTMLElement | null): void {
  const idx = THEMES.findIndex((t) => t.id === settings.value.theme);
  setTheme(THEMES[(idx + 1) % THEMES.length].id, origin);
}
