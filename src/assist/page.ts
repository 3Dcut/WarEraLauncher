// Gemeinsamer Start für die eigenen Werkzeugseiten (Kisten-Assistent, Marktcheck): Schriften, Theme,
// Akzentfarbe und Bewegung aus den Launcher-Einstellungen (gleiche Herkunft, gleicher Speicher), Sprache.

import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource-variable/quicksand';
import '@fontsource-variable/source-code-pro';
import '../styles/tokens.css';
import '../styles/base.css';
import './assist.css';

import { effect } from '@preact/signals';
import { lang, t, type MessageKey } from '../i18n';

const THEMES = ['grau', 'feldgrau', 'pink', 'hell'];

export const embedded = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

function applyTheme(): void {
  const root = document.documentElement;
  let s: { theme?: string; accentHue?: number | null; motion?: string; density?: string } | null = null;
  try {
    s = JSON.parse(localStorage.getItem('wl2:settings') ?? 'null');
  } catch {
    s = null;
  }
  root.dataset.theme = s?.theme && THEMES.includes(s.theme) ? s.theme : 'grau';
  if (typeof s?.accentHue === 'number') root.style.setProperty('--accent-h', String(s.accentHue));
  else root.style.removeProperty('--accent-h');
  const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduced = s?.motion === 'off' || s?.motion === 'reduced' || (s?.motion !== 'full' && systemReduced);
  root.dataset.motion = reduced ? 'reduced' : 'full';
  root.style.colorScheme = root.dataset.theme === 'hell' ? 'light' : 'dark';
}

/** Theme übernehmen, Titel und Beschreibung je Sprache setzen. */
export function bootPage(titleKey: MessageKey, descriptionKey: MessageKey): void {
  applyTheme();
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'wl2:settings') applyTheme();
  });
  document.body.classList.add('assist');
  if (embedded) document.body.classList.add('is-embedded');
  effect(() => {
    document.documentElement.lang = lang.value;
    document.title = `${t(titleKey)} · WarEra Launcher`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', t(descriptionKey));
  });
}
