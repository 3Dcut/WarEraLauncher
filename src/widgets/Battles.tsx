import { useEffect, useRef, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { getActiveBattles, getCountries, getRegions, getTournamentTeamNumber, type Battle, type BattleSide, type CountryInfo } from '../warera/api';
import { countryName } from '../warera/dates';
import { settings } from '../state';
import { useVisibleInterval, Segmented } from '../ui/primitives';
import { Icon } from '../ui/icons';
import { t, tn, type MessageKey } from '../i18n';

const POINTS_TO_WIN = 300;

const TYPE_LABEL: Record<string, MessageKey> = {
  war: 'widgets.battles.type.war',
  resistance: 'widgets.battles.type.resistance',
  revolt: 'widgets.battles.type.revolt',
  civilWar: 'widgets.battles.type.civilWar',
  tournament: 'widgets.battles.type.tournament',
};

export function BattlesWidget({ visible }: { visible: Signal<boolean> }) {
  const [scope, setScope] = useState<'mine' | 'all'>(settings.value.countryId ? 'mine' : 'all');
  const [battles, setBattles] = useState<Battle[] | null>(null);
  const [countries, setCountries] = useState<Record<string, CountryInfo>>({});
  const [regions, setRegions] = useState<Record<string, string>>({});
  const [teams, setTeams] = useState<Record<string, number | null>>({});
  const [error, setError] = useState(false);
  const countryId = settings.value.countryId;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = () => {
    const wanted = scope;
    getActiveBattles(wanted === 'mine' ? countryId : null)
      .then((list) => {
        // Eine verspätete Antwort für den vorherigen Filter darf die neue Liste nicht überschreiben.
        if (scopeRef.current !== wanted) return;
        setBattles(list);
        setError(false);
      })
      .catch(() => setError(true));
  };

  useVisibleInterval(load, 60_000, visible.value);
  // Nach dem Umschalten sofort laden, statt bis zum nächsten Takt "Lade Schlachten …" zu zeigen.
  useEffect(() => {
    if (visible.value) load();
  }, [scope]);
  useVisibleInterval(
    () => {
      if (!Object.keys(countries).length) getCountries().then(setCountries).catch(() => undefined);
      if (!Object.keys(regions).length) getRegions().then(setRegions).catch(() => undefined);
    },
    3600_000,
    visible.value,
  );

  // Turnierschlachten haben statt Ländern Teams, die nur eine Nummer tragen.
  useEffect(() => {
    const missing = [...new Set((battles ?? []).flatMap((b) => [b.attacker.tournamentTeam, b.defender.tournamentTeam]))].filter(
      (id): id is string => !!id && !(id in teams),
    );
    for (const id of missing) {
      getTournamentTeamNumber(id)
        .then((n) => setTeams((t) => ({ ...t, [id]: n })))
        .catch(() => setTeams((t) => ({ ...t, [id]: null })));
    }
  }, [battles]);

  const countryLabel = (id: string) => {
    const c = countries[id];
    return c ? countryName(c.code, c.name) : '…';
  };
  const teamNumber = (side: BattleSide) => (side.tournamentTeam ? teams[side.tournamentTeam] : undefined);
  const name = (side: BattleSide) => {
    if (side.country) return countryLabel(side.country);
    if (side.tournamentTeam) {
      const n = teamNumber(side);
      return n == null ? t('widgets.battles.tournamentTeam') : t('widgets.battles.team', { n });
    }
    return '…';
  };
  const code = (side: BattleSide) => {
    if (side.country) return countries[side.country]?.code?.toUpperCase() ?? '??';
    const n = teamNumber(side);
    return n == null ? 'T' : `T${n}`;
  };
  const mine = countryId ? countryLabel(countryId) : t('widgets.battles.myCountry');

  return (
    <div class="battles">
      <div class="battles__bar">
        <Segmented
          name={t('widgets.battles.filter')}
          value={scope}
          onChange={(v) => {
            setScope(v);
            setBattles(null);
          }}
          options={[
            { value: 'mine', label: mine },
            { value: 'all', label: t('widgets.battles.worldwide') },
          ]}
        />
        {battles && <span class="muted">{tn('widgets.battles.active', battles.length)}</span>}
      </div>
      {!battles && <div class="widget-empty">{error ? t('widgets.battles.unreachable') : t('widgets.battles.loading')}</div>}
      {battles && battles.length === 0 && <div class="widget-empty">{scope === 'mine' ? t('widgets.battles.noneFor', { country: mine }) : t('widgets.battles.none')}</div>}
      <ul class="battle-list">
        {battles?.map((b) => {
          const a = b.currentRound?.attacker?.points ?? 0;
          const d = b.currentRound?.defender?.points ?? 0;
          const ours = countryId && (b.attacker.country === countryId ? 'attacker' : b.defender.country === countryId ? 'defender' : null);
          const region = regions[b.defender.region ?? ''] ?? regions[b.attacker.region ?? ''];
          return (
            <li class={`battle ${ours ? `battle--${ours}` : ''}`}>
              <div class="battle__head">
                <span class="badge">{TYPE_LABEL[b.type ?? ''] ? t(TYPE_LABEL[b.type ?? '']) : (b.type ?? t('widgets.battles.type.default'))}</span>
                {region && <span class="battle__region">{region}</span>}
                <a class="icon-btn" href={`https://app.warera.io/battle/${b._id}`} target="_blank" rel="noopener" title={t('widgets.battles.viewInGame')} aria-label={t('widgets.battles.viewInGame')}>
                  <Icon name="external" size={14} />
                </a>
              </div>
              <div class="battle__sides">
                <div class="side side--att">
                  <span class="cc">{code(b.attacker)}</span>
                  <span class="side__name">{name(b.attacker)}</span>
                </div>
                <div class="battle__score mono" title={t('widgets.battles.roundsWon')}>
                  {b.attacker.wonRoundsCount ?? 0}:{b.defender.wonRoundsCount ?? 0}
                </div>
                <div class="side side--def">
                  <span class="side__name">{name(b.defender)}</span>
                  <span class="cc">{code(b.defender)}</span>
                </div>
              </div>
              <div class="round" aria-label={t('widgets.battles.roundAria', { a, d, goal: POINTS_TO_WIN })}>
                <div class="round__att" style={{ width: `${Math.min(100, (a / POINTS_TO_WIN) * 100)}%` }} />
                <div class="round__def" style={{ width: `${Math.min(100, (d / POINTS_TO_WIN) * 100)}%` }} />
              </div>
              <div class="battle__meta mono">
                <span>{a}</span>
                <span class="muted">{t('widgets.battles.roundGoal', { goal: POINTS_TO_WIN })}</span>
                <span>{d}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
