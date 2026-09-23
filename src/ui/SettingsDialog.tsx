import { useEffect, useRef, useState } from 'preact/hooks';
import { settings, updateSettings, settingsOpen, THEMES, toast, type Density, type MotionPref } from '../state';
import { setTheme } from '../theme';
import { dumpAll, restoreAll, clearAll, requestPersistence } from '../core/storage';
import { getCountries, type CountryInfo } from '../warera/api';
import { countryName } from '../warera/dates';
import { Dialog, Switch, Segmented } from './primitives';
import { Icon } from './icons';

const THEME_SWATCH: Record<string, [string, string, string]> = {
  grau: ['#0b1020', '#182238', '#f0b429'],
  feldgrau: ['#12150f', '#20261a', '#c8b560'],
  pink: ['#16061c', '#2a0c35', '#ff4fd8'],
  hell: ['#eef1f5', '#ffffff', '#b7791f'],
};

export function SettingsDialog() {
  const s = settings.value;
  const [countries, setCountries] = useState<Record<string, CountryInfo>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settingsOpen.value && !Object.keys(countries).length) getCountries().then(setCountries).catch(() => undefined);
    if (!settingsOpen.value) setConfirmReset(false);
  }, [settingsOpen.value]);

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ app: 'warera-launcher', version: 2, data: dumpAll() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `warera-launcher-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importData = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { app?: string; data?: Record<string, unknown> };
      if (parsed.app !== 'warera-launcher' || !parsed.data) throw new Error('Format');
      restoreAll(parsed.data);
      toast('Einstellungen importiert. Die Seite lädt neu.', 'success');
      setTimeout(() => location.reload(), 900);
    } catch {
      toast('Die Datei ist kein Export des WarEra Launchers.', 'warn');
    }
  };

  const countryList = Object.entries(countries)
    .map(([id, c]) => ({ id, name: countryName(c.code, c.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));

  return (
    <Dialog open={settingsOpen.value} onClose={() => (settingsOpen.value = false)} title="Einstellungen" icon="settings" class="settings">
      <section class="settings__section">
        <h3>Darstellung</h3>
        <div class="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => {
            const [ground, surface, accent] = THEME_SWATCH[t.id];
            return (
              <button
                type="button"
                role="radio"
                aria-checked={s.theme === t.id}
                class={`theme-card ${s.theme === t.id ? 'is-active' : ''}`}
                onClick={(e) => setTheme(t.id, e.currentTarget as HTMLElement)}
              >
                <span class="theme-card__swatch" style={{ background: ground }} aria-hidden="true">
                  <span style={{ background: surface }} />
                  <span style={{ background: accent }} />
                </span>
                <span class="theme-card__name">{t.name}</span>
                <span class="theme-card__hint">{t.hint}</span>
              </button>
            );
          })}
        </div>

        <div class="field">
          <div class="field__label">
            <label for="accent-hue">Akzentfarbe</label>
            {s.accentHue != null && (
              <button type="button" class="link-btn" onClick={() => updateSettings({ accentHue: null })}>
                Farbe des Themes
              </button>
            )}
          </div>
          <input
            id="accent-hue"
            class="hue-slider"
            type="range"
            min={0}
            max={360}
            step={1}
            value={s.accentHue ?? 80}
            onInput={(e) => updateSettings({ accentHue: Number((e.target as HTMLInputElement).value) })}
          />
        </div>

        <div class="field field--row">
          <span class="field__label">Dichte</span>
          <Segmented<Density>
            name="Dichte"
            value={s.density}
            onChange={(density) => updateSettings({ density })}
            options={[
              { value: 'comfortable', label: 'Luftig' },
              { value: 'compact', label: 'Kompakt' },
            ]}
          />
        </div>

        <div class="field field--row">
          <span class="field__label">Animationen</span>
          <Segmented<MotionPref>
            name="Animationen"
            value={s.motion}
            onChange={(motion) => updateSettings({ motion })}
            options={[
              { value: 'auto', label: 'Automatisch' },
              { value: 'reduced', label: 'Reduziert' },
              { value: 'off', label: 'Aus' },
            ]}
          />
        </div>

        <div class="field">
          <div class="field__label">
            <label for="glass">Glas-Effekt</label>
            <span class="muted">{s.glass === 0 ? 'deckend' : `${Math.round(s.glass * 100)} %`}</span>
          </div>
          <input id="glass" type="range" min={0} max={1} step={0.05} value={s.glass} onInput={(e) => updateSettings({ glass: Number((e.target as HTMLInputElement).value) })} />
        </div>
      </section>

      <section class="settings__section">
        <h3>WarEra</h3>
        <div class="field field--row">
          <span class="field__label">
            Charakter
            <small>{s.characterName ?? 'nicht festgelegt'}</small>
          </span>
          {s.characterId && (
            <button type="button" class="btn btn--ghost btn--sm" onClick={() => updateSettings({ characterId: null, characterName: null })}>
              Zurücksetzen
            </button>
          )}
        </div>
        <div class="field">
          <label class="field__label" for="country">
            Mein Land (für „Front“)
          </label>
          <select id="country" class="input" value={s.countryId ?? ''} onChange={(e) => updateSettings({ countryId: (e.target as HTMLSelectElement).value || null })}>
            <option value="">– kein Land –</option>
            {countryList.map((c) => (
              <option value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </section>

      <section class="settings__section">
        <h3>Hinweise</h3>
        <Switch
          id="notify-live"
          checked={s.notifyLive}
          label="Desktop-Hinweis, wenn ein Sender live geht"
          hint="Nur solange der Launcher geöffnet ist. Im Launcher selbst erscheint immer ein Hinweis."
          onChange={async (v) => {
            if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
              const result = await Notification.requestPermission();
              if (result !== 'granted') {
                toast('Der Browser hat Benachrichtigungen abgelehnt.', 'warn');
                return;
              }
            }
            updateSettings({ notifyLive: v });
          }}
        />
      </section>

      <section class="settings__section">
        <h3>Daten</h3>
        <p class="muted">Layouts, Favoriten und Einstellungen liegen nur in diesem Browser. Mit einem Export nimmst du sie auf einen anderen Rechner mit.</p>
        <div class="btn-row">
          <button type="button" class="btn btn--ghost" onClick={exportData}>
            <Icon name="download" /> Exportieren
          </button>
          <button type="button" class="btn btn--ghost" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" /> Importieren
          </button>
          <input
            ref={fileInput}
            id="import-file"
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void importData(f);
            }}
          />
          <button
            type="button"
            class="btn btn--ghost"
            onClick={() => {
              requestPersistence();
              toast('Der Browser wurde gebeten, die Daten dauerhaft zu behalten.', 'success');
            }}
          >
            <Icon name="shield" /> Dauerhaft speichern
          </button>
        </div>
        <div class="btn-row">
          {confirmReset ? (
            <button
              type="button"
              class="btn btn--danger"
              onClick={() => {
                clearAll();
                location.reload();
              }}
            >
              <Icon name="trash" /> Wirklich alles zurücksetzen
            </button>
          ) : (
            <button type="button" class="btn btn--ghost btn--danger-text" onClick={() => setConfirmReset(true)}>
              <Icon name="trash" /> Alles zurücksetzen
            </button>
          )}
          <a class="btn btn--ghost" href="./legacy.html">
            <Icon name="external" /> Alte Oberfläche
          </a>
        </div>
      </section>
    </Dialog>
  );
}
