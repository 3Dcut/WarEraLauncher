import { useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { getUser, searchUsers, type UserLite } from '../warera/api';
import { gameDates, countryName } from '../warera/dates';
import { getCountries, type CountryInfo } from '../warera/api';
import { settings, updateSettings } from '../state';
import { formatClock } from '../core/clock';
import { useVisibleInterval } from '../ui/primitives';
import { Icon } from '../ui/icons';
import { t, tn, tx, formatNumber, type MessageKey } from '../i18n';

const BARS: { key: string; label: MessageKey; tone: string }[] = [
  { key: 'energy', label: 'widgets.character.bar.energy', tone: 'energy' },
  { key: 'health', label: 'widgets.character.bar.health', tone: 'health' },
  { key: 'hunger', label: 'widgets.character.bar.hunger', tone: 'hunger' },
  { key: 'entrepreneurship', label: 'widgets.character.bar.entrepreneurship', tone: 'entre' },
];

/** Balken regenerieren zur vollen Stunde um hourlyBarRegen; daraus folgt der Zeitpunkt "voll". */
export function fullAt(current: number, total: number, hourly: number, nextRegenAt: number): number | null {
  if (current >= total) return null;
  if (!hourly || hourly <= 0) return NaN;
  const hours = Math.ceil((total - current) / hourly);
  return nextRegenAt + (hours - 1) * 3_600_000;
}

export function CharacterWidget({ visible }: { visible: Signal<boolean> }) {
  const id = settings.value.characterId;
  if (!id) return <CharacterSearch />;
  return <CharacterCard id={id} visible={visible} />;
}

function CharacterCard({ id, visible }: { id: string; visible: Signal<boolean> }) {
  const [user, setUser] = useState<UserLite | null>(null);
  const [error, setError] = useState(false);
  const [countries, setCountries] = useState<Record<string, CountryInfo>>({});

  useVisibleInterval(
    () => {
      getUser(id)
        .then((u) => {
          setUser(u);
          setError(false);
        })
        .catch(() => setError(true));
      if (!Object.keys(countries).length) getCountries().then(setCountries).catch(() => undefined);
    },
    120_000,
    visible.value,
  );

  if (error && !user) return <div class="widget-empty">{t('widgets.character.loadError')}</div>;
  if (!user) return <div class="widget-empty">{t('widgets.character.loading')}</div>;

  const regen = gameDates.value ? Date.parse(gameDates.value.nextRegenAt) : Date.now() + 3_600_000;
  const country = user.country ? countries[user.country] : undefined;

  return (
    <div class="character">
      <header class="character__head">
        {user.avatarUrl ? <img class="avatar" src={user.avatarUrl} alt="" loading="lazy" referrerpolicy="no-referrer" /> : <div class="avatar avatar--empty" />}
        <div class="character__id">
          <strong>{user.username}</strong>
          <span class="muted">
            {t('widgets.character.level', { level: user.leveling?.level ?? '–' })}
            {country && ` · ${countryName(country.code, country.name)}`}
          </span>
        </div>
        <button type="button" class="icon-btn" title={t('widgets.character.change')} aria-label={t('widgets.character.change')} onClick={() => updateSettings({ characterId: null, characterName: null })}>
          <Icon name="edit" />
        </button>
      </header>

      <div class="bars">
        {BARS.map((b) => {
          const skill = user.skills?.[b.key];
          if (!skill || skill.total == null) return null;
          const current = skill.currentBarValue ?? 0;
          const total = skill.total;
          const full = fullAt(current, total, skill.hourlyBarRegen ?? 0, regen);
          return (
            <div class={`bar bar--${b.tone}`}>
              <div class="bar__label">
                <span>{t(b.label)}</span>
                <span class="mono">
                  {fmt(current)} / {fmt(total)}
                </span>
              </div>
              <div class="bar__track" role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={current} aria-label={t(b.label)}>
                <div class="bar__fill" style={{ width: `${Math.min(100, (current / total) * 100)}%` }} />
              </div>
              <div class="bar__meta">
                <span>{t('widgets.character.perHour', { value: fmt(skill.hourlyBarRegen ?? 0) })}</span>
                <span>{full === null ? t('widgets.character.full') : Number.isNaN(full) ? '–' : t('widgets.character.fullAt', { time: formatClock(new Date(full)) })}</span>
              </div>
            </div>
          );
        })}
      </div>

      {user.leveling && (
        <div class="character__foot">
          <span>
            {tx('widgets.character.dailyXpLeft', { value: <strong class="mono">{user.leveling.dailyXpLeft ?? 0}</strong> })}
          </span>
          {(user.leveling.availableSkillPoints ?? 0) > 0 && <span class="badge badge--accent">{tn('widgets.character.skillPoints', user.leveling.availableSkillPoints ?? 0)}</span>}
        </div>
      )}
    </div>
  );
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function CharacterSearch() {
  const [query, setQuery] = useState(settings.value.characterName ?? '');
  const [results, setResults] = useState<UserLite[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: Event) => {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    try {
      setResults(await searchUsers(query.trim()));
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="character-search">
      <p>{t('widgets.character.searchIntro')}</p>
      <form class="inline-form" onSubmit={run}>
        <input id="character-query" class="input" placeholder={t('widgets.character.playerName')} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} autocomplete="off" />
        <button class="btn btn--primary" type="submit" disabled={busy}>
          <Icon name="search" />
          <span>{busy ? t('widgets.character.searching') : t('widgets.character.search')}</span>
        </button>
      </form>
      {results && results.length === 0 && <p class="muted">{t('widgets.character.notFound')}</p>}
      {results && results.length > 0 && (
        <ul class="pick-list">
          {results.map((u) => (
            <li>
              <button type="button" onClick={() => updateSettings({ characterId: u._id, characterName: u.username })}>
                {u.avatarUrl ? <img class="avatar avatar--sm" src={u.avatarUrl} alt="" loading="lazy" referrerpolicy="no-referrer" /> : <span class="avatar avatar--sm avatar--empty" />}
                <span>{u.username}</span>
                <span class="muted">{t('widgets.character.level', { level: u.leveling?.level ?? '–' })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
