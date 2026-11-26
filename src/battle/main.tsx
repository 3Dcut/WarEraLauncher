import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource-variable/quicksand';
import '@fontsource-variable/source-code-pro';
import '../styles/tokens.css';
import '../styles/base.css';
import './battle.css';

import { render } from 'preact';
import { BattleApp } from './BattleApp';
import { loadRarities } from './api';
import { resumeStored, setReducedMotion } from './engine';
import { setFxReduced } from './fx';
import { loadPrefs, savePrefs } from './prefs';
import { caseFromParam } from './logic';
import { apiKey } from '../core/apiKey';
import { effect } from '@preact/signals';
import { lang, t } from '../i18n';

// Theme, Akzentfarbe und Bewegung aus den Launcher-Einstellungen übernehmen (gleiche Herkunft, gleicher Speicher)
const THEMES = ['grau', 'feldgrau', 'pink', 'hell'];
function applyTheme(): void {
  const root = document.documentElement;
  let s: { theme?: string; accentHue?: number | null; motion?: string } | null = null;
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
  setReducedMotion(reduced);
  setFxReduced(reduced);
}
applyTheme();
window.addEventListener('storage', (e) => {
  if (!e.key || e.key === 'wl2:settings') applyTheme();
});

// Voreinstellungen aus dem Link: ?a=Name&b=Name&kiste=rot|gruen&start=1 (etwa für OBS), ?demo=1 zum Ausprobieren
const params = new URLSearchParams(location.search);
const prefs = loadPrefs();
const a = params.get('a');
const b = params.get('b');
if (a !== null || b !== null) prefs.names = [a ?? prefs.names[0], b ?? prefs.names[1]];
const kiste = caseFromParam(params.get('kiste') ?? params.get('case'));
if (kiste) prefs.caseCode = kiste;
savePrefs(prefs);
const demo = params.get('demo') === '1';
const autostart = params.get('start') === '1';

document.body.classList.add('battle');
// Sprache wie im Launcher (?lang=, gespeicherte Wahl, sonst Browser)
effect(() => {
  document.documentElement.lang = lang.value;
  document.title = `${t('battle.title')} · WarEra Launcher`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('battle.docDescription'));
});
void loadRarities();
if (!demo && !(a || b)) resumeStored(apiKey.value || null);

const root = document.getElementById('battle')!;
root.textContent = '';
render(<BattleApp initial={{ prefs, autostart, demo }} />, root);
