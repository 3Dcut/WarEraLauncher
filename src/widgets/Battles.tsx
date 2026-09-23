import { useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { getActiveBattles, getCountries, getRegions, type Battle, type CountryInfo } from '../warera/api';
import { countryName } from '../warera/dates';
import { settings } from '../state';
import { useVisibleInterval, Segmented } from '../ui/primitives';
import { Icon } from '../ui/icons';

const POINTS_TO_WIN = 300;

const TYPE_LABEL: Record<string, string> = {
  war: 'Krieg',
  resistance: 'Widerstand',
  revolt: 'Aufstand',
  civilWar: 'Bürgerkrieg',
};

export function BattlesWidget({ visible }: { visible: Signal<boolean> }) {
  const [scope, setScope] = useState<'mine' | 'all'>(settings.value.countryId ? 'mine' : 'all');
  const [battles, setBattles] = useState<Battle[] | null>(null);
  const [countries, setCountries] = useState<Record<string, CountryInfo>>({});
  const [regions, setRegions] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const countryId = settings.value.countryId;

  useVisibleInterval(
    () => {
      getActiveBattles(scope === 'mine' ? countryId : null)
        .then((list) => {
          setBattles(list);
          setError(false);
        })
        .catch(() => setError(true));
    },
    60_000,
    visible.value,
  );
  useVisibleInterval(
    () => {
      if (!Object.keys(countries).length) getCountries().then(setCountries).catch(() => undefined);
      if (!Object.keys(regions).length) getRegions().then(setRegions).catch(() => undefined);
    },
    3600_000,
    visible.value,
  );

  const name = (id: string) => {
    const c = countries[id];
    return c ? countryName(c.code, c.name) : '…';
  };
  const code = (id: string) => countries[id]?.code?.toUpperCase() ?? '??';
  const mine = countryId ? name(countryId) : 'Mein Land';

  return (
    <div class="battles">
      <div class="battles__bar">
        <Segmented
          name="Schlachten filtern"
          value={scope}
          onChange={(v) => {
            setScope(v);
            setBattles(null);
          }}
          options={[
            { value: 'mine', label: mine },
            { value: 'all', label: 'Weltweit' },
          ]}
        />
        {battles && <span class="muted">{battles.length} aktiv</span>}
      </div>
      {!battles && <div class="widget-empty">{error ? 'Schlachten nicht erreichbar.' : 'Lade Schlachten …'}</div>}
      {battles && battles.length === 0 && <div class="widget-empty">Gerade keine laufenden Schlachten{scope === 'mine' ? ` mit Beteiligung von ${mine}` : ''}.</div>}
      <ul class="battle-list">
        {battles?.map((b) => {
          const a = b.currentRound?.attacker?.points ?? 0;
          const d = b.currentRound?.defender?.points ?? 0;
          const ours = countryId && (b.attacker.country === countryId ? 'attacker' : b.defender.country === countryId ? 'defender' : null);
          const region = regions[b.defender.region ?? ''] ?? regions[b.attacker.region ?? ''];
          return (
            <li class={`battle ${ours ? `battle--${ours}` : ''}`}>
              <div class="battle__head">
                <span class="badge">{TYPE_LABEL[b.type ?? ''] ?? b.type ?? 'Schlacht'}</span>
                {region && <span class="battle__region">{region}</span>}
                <a class="icon-btn" href={`https://app.warera.io/battle/${b._id}`} target="_blank" rel="noopener" title="Im Spiel ansehen" aria-label="Im Spiel ansehen">
                  <Icon name="external" size={14} />
                </a>
              </div>
              <div class="battle__sides">
                <div class="side side--att">
                  <span class="cc">{code(b.attacker.country)}</span>
                  <span class="side__name">{name(b.attacker.country)}</span>
                </div>
                <div class="battle__score mono" title="Gewonnene Runden">
                  {b.attacker.wonRoundsCount ?? 0}:{b.defender.wonRoundsCount ?? 0}
                </div>
                <div class="side side--def">
                  <span class="side__name">{name(b.defender.country)}</span>
                  <span class="cc">{code(b.defender.country)}</span>
                </div>
              </div>
              <div class="round" aria-label={`Aktuelle Runde: ${a} zu ${d} von ${POINTS_TO_WIN} Punkten`}>
                <div class="round__att" style={{ width: `${Math.min(100, (a / POINTS_TO_WIN) * 100)}%` }} />
                <div class="round__def" style={{ width: `${Math.min(100, (d / POINTS_TO_WIN) * 100)}%` }} />
              </div>
              <div class="battle__meta mono">
                <span>{a}</span>
                <span class="muted">Runde · Ziel {POINTS_TO_WIN}</span>
                <span>{d}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
