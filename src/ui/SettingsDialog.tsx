import { useEffect, useRef, useState } from 'preact/hooks';
import { settings, updateSettings, settingsOpen, THEMES, toast, type Density, type MotionPref } from '../state';
import { setTheme } from '../theme';
import { dumpAll, restoreAll, clearAll, requestPersistence } from '../core/storage';
import { getCountries, type CountryInfo } from '../warera/api';
import { countryName } from '../warera/dates';
import { Dialog, Switch, Segmented } from './primitives';
import { Icon } from './icons';
import { t, LANGS, langChoice, setLang, compareText, type LangPref } from '../i18n';
import { apiKey, setApiKey, verifyApiKey, originDecisions, decideOrigin, forgetApiKeyData } from '../core/apiKey';
import { InfoTip } from './InfoTip';

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
      toast(t('settings.imported'), 'success');
      setTimeout(() => location.reload(), 900);
    } catch {
      toast(t('settings.importInvalid'), 'warn');
    }
  };

  const countryList = Object.entries(countries)
    .map(([id, c]) => ({ id, name: countryName(c.code, c.name) }))
    .sort((a, b) => compareText(a.name, b.name));

  return (
    <Dialog open={settingsOpen.value} onClose={() => (settingsOpen.value = false)} title={t('settings.title')} icon="settings" class="settings">
      <section class="settings__section">
        <h3>{t('settings.appearance')}</h3>
        <div class="field">
          <div class="field__label">
            <span>{t('settings.language')}</span>
          </div>
          <Segmented<LangPref>
            name={t('settings.language')}
            value={langChoice.value}
            onChange={(pref) => setLang(pref)}
            options={[{ value: 'auto', label: t('settings.languageAuto') }, ...LANGS.map((l) => ({ value: l.id as LangPref, label: l.name }))]}
          />
          <small class="muted">{t('settings.languageHint')}</small>
        </div>

        <div class="theme-grid" role="radiogroup" aria-label={t('settings.theme')}>
          {THEMES.map((th) => {
            const [ground, surface, accent] = THEME_SWATCH[th.id];
            return (
              <button
                type="button"
                role="radio"
                aria-checked={s.theme === th.id}
                class={`theme-card ${s.theme === th.id ? 'is-active' : ''}`}
                onClick={(e) => setTheme(th.id, e.currentTarget as HTMLElement)}
              >
                <span class="theme-card__swatch" style={{ background: ground }} aria-hidden="true">
                  <span style={{ background: surface }} />
                  <span style={{ background: accent }} />
                </span>
                <span class="theme-card__name">{th.name}</span>
                <span class="theme-card__hint">{th.hint}</span>
              </button>
            );
          })}
        </div>

        <div class="field">
          <div class="field__label">
            <label for="accent-hue">{t('settings.accent')}</label>
            {s.accentHue != null && (
              <button type="button" class="link-btn" onClick={() => updateSettings({ accentHue: null })}>
                {t('settings.accentReset')}
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
          <span class="field__label">{t('settings.density')}</span>
          <Segmented<Density>
            name={t('settings.density')}
            value={s.density}
            onChange={(density) => updateSettings({ density })}
            options={[
              { value: 'comfortable', label: t('settings.density.comfortable') },
              { value: 'compact', label: t('settings.density.compact') },
            ]}
          />
        </div>

        <div class="field field--row">
          <span class="field__label">{t('settings.motion')}</span>
          <Segmented<MotionPref>
            name={t('settings.motion')}
            value={s.motion}
            onChange={(motion) => updateSettings({ motion })}
            options={[
              { value: 'auto', label: t('settings.motion.auto') },
              { value: 'reduced', label: t('settings.motion.reduced') },
              { value: 'off', label: t('settings.motion.off') },
            ]}
          />
        </div>

        <div class="field">
          <div class="field__label">
            <label for="glass">{t('settings.glass')}</label>
            <span class="muted">{s.glass === 0 ? t('settings.glassOpaque') : `${Math.round(s.glass * 100)} %`}</span>
          </div>
          <input id="glass" type="range" min={0} max={1} step={0.05} value={s.glass} onInput={(e) => updateSettings({ glass: Number((e.target as HTMLInputElement).value) })} />
        </div>
      </section>

      <section class="settings__section">
        <h3>{t('settings.warera')}</h3>
        <div class="field field--row">
          <span class="field__label">
            {t('settings.character')}
            <small>{s.characterName ?? t('settings.characterUnset')}</small>
          </span>
          {s.characterId && (
            <button type="button" class="btn btn--ghost btn--sm" onClick={() => updateSettings({ characterId: null, characterName: null })}>
              {t('settings.characterReset')}
            </button>
          )}
        </div>
        <div class="field">
          <label class="field__label" for="country">
            {t('settings.country')}
          </label>
          <select id="country" class="input" value={s.countryId ?? ''} onChange={(e) => updateSettings({ countryId: (e.target as HTMLSelectElement).value || null })}>
            <option value="">{t('settings.countryNone')}</option>
            {countryList.map((c) => (
              <option value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <ApiKeyField />
      </section>

      <section class="settings__section">
        <h3>{t('settings.notifications')}</h3>
        <Switch
          id="notify-live"
          checked={s.notifyLive}
          label={t('settings.notifyLive')}
          hint={t('settings.notifyLiveHint')}
          onChange={async (v) => {
            if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
              const result = await Notification.requestPermission();
              if (result !== 'granted') {
                toast(t('settings.notifyDenied'), 'warn');
                return;
              }
            }
            updateSettings({ notifyLive: v });
          }}
        />
      </section>

      <section class="settings__section">
        <h3>{t('settings.data')}</h3>
        <p class="muted">{t('settings.dataHint')}</p>
        <div class="btn-row">
          <button type="button" class="btn btn--ghost" onClick={exportData}>
            <Icon name="download" /> {t('settings.export')}
          </button>
          <button type="button" class="btn btn--ghost" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" /> {t('settings.import')}
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
              toast(t('settings.persistAsked'), 'success');
            }}
          >
            <Icon name="shield" /> {t('settings.persist')}
          </button>
        </div>
        <div class="btn-row">
          {confirmReset ? (
            <button
              type="button"
              class="btn btn--danger"
              onClick={() => {
                clearAll();
                forgetApiKeyData();
                location.reload();
              }}
            >
              <Icon name="trash" /> {t('settings.resetAllConfirm')}
            </button>
          ) : (
            <button type="button" class="btn btn--ghost btn--danger-text" onClick={() => setConfirmReset(true)}>
              <Icon name="trash" /> {t('settings.resetAll')}
            </button>
          )}
          <a class="btn btn--ghost" href="./legacy.html">
            <Icon name="external" /> {t('settings.legacy')}
          </a>
        </div>
      </section>
    </Dialog>
  );
}

/** Persönlicher WarEra-API-Schlüssel: gilt für den Launcher und wird an Tools weitergegeben. */
function ApiKeyField() {
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<'ok' | 'invalid' | null>(null);
  const key = apiKey.value;
  const decisions = Object.entries(originDecisions.value);

  useEffect(() => {
    setStatus(null);
    if (key.length < 8) return;
    let stale = false;
    const timer = setTimeout(() => {
      void verifyApiKey(key).then((r) => !stale && setStatus(r === 'error' ? null : r));
    }, 600);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [key]);

  return (
    <div class="field">
      <div class="field__label">
        <span>
          <label for="api-key">{t('settings.apiKey')}</label>
          <InfoTip text={t('settings.apiKeyHelp')} label={t('settings.apiKey')} />
        </span>
        {status && <span class={status === 'ok' ? 'key-status key-status--ok' : 'key-status key-status--bad'}>{status === 'ok' ? `✓ ${t('settings.apiKeyOk')}` : t('settings.apiKeyInvalid')}</span>}
      </div>
      <div class="key-row">
        <input
          id="api-key"
          class="input mono"
          type={show ? 'text' : 'password'}
          autocomplete="off"
          spellcheck={false}
          placeholder={t('settings.apiKeyPlaceholder')}
          value={key}
          onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
        />
        <button type="button" class="btn btn--ghost btn--sm" onClick={() => setShow(!show)}>
          {show ? t('settings.apiKeyHide') : t('settings.apiKeyShow')}
        </button>
        {key && (
          <button type="button" class="btn btn--ghost btn--sm btn--danger-text" onClick={() => setApiKey('')}>
            {t('settings.apiKeyRemove')}
          </button>
        )}
      </div>
      {decisions.length > 0 && (
        <ul class="key-origins">
          {decisions.map(([origin, decision]) => (
            <li>
              <span class="mono">{origin.replace(/^https?:\/\//, '')}</span>
              <span class={decision === 'allow' ? 'key-status--ok' : 'muted'}>{decision === 'allow' ? t('settings.apiKeyAllowed') : t('settings.apiKeyDenied')}</span>
              <button type="button" class="link-btn" onClick={() => decideOrigin(origin, null)}>
                {t('settings.apiKeyForget')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
