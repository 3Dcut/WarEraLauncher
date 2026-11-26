import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import {
  phase,
  match,
  slots,
  standing,
  backlog,
  banner,
  poll,
  fatal,
  lastRound,
  startMatch,
  stopMatch,
  setTip,
  setRate,
  type Slot,
} from './engine';
import { findPlayer, checkKey, type Player, type Lookup } from './api';
import { CASE_TYPES, RARITIES, itemInfo, rarityRank, type Opening, type Rarity, type Side } from './logic';
import { rarityLabel, itemName, skillsText, caseText, sideLabel } from './text';
import { savePrefs, loadKey, saveKey, clampTarget, RATES, type BattlePrefs } from './prefs';
import { setSoundEnabled, unlockAudio } from './sound';
import { burstAt, rain } from './fx';
import { t, tn, formatNumber } from '../i18n';

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#a7b0c0',
  uncommon: '#4ade80',
  rare: '#60a5fa',
  epic: '#c084fc',
  legendary: '#fbbf24',
  mythic: '#f43f5e',
};

const embedded = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

const other = (side: Side): Side => (side === 0 ? 1 : 0);

// ------------------------------------------------------------------ App

export function BattleApp({ initial }: { initial: { prefs: BattlePrefs; autostart: boolean; demo: boolean } }) {
  const [prefs, setPrefs] = useState<BattlePrefs>(initial.prefs);
  const update = (patch: Partial<BattlePrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  };

  useEffect(() => setSoundEnabled(prefs.sound), [prefs.sound]);
  useEffect(() => setRate(prefs.rate), [prefs.rate]);

  const ph = phase.value;
  return (
    <div class={`battle-app ${embedded ? 'is-embedded' : ''}`}>
      <Header prefs={prefs} update={update} />
      {ph === 'setup' || (ph === 'arming' && !match.value) ? <Setup prefs={prefs} update={update} initial={initial} /> : <Arena prefs={prefs} />}
      {ph === 'finished' && <Victory prefs={prefs} />}
      <Banner />
      <Announcer />
    </div>
  );
}

// ------------------------------------------------------------------ Kopf

function Header({ prefs, update }: { prefs: BattlePrefs; update: (p: Partial<BattlePrefs>) => void }) {
  const label = prefs.sound ? t('battle.sound.off') : t('battle.sound.on');
  return (
    <header class="b-header">
      <div class="b-brand">
        <MiniCrate />
        <div>
          <h1>{t('battle.title')}</h1>
          <p class="b-sub">{t('battle.subtitle')}</p>
        </div>
      </div>
      <div class="b-header__right">
        <LiveChip />
        <button
          type="button"
          class={`icon-btn ${prefs.sound ? 'is-active' : ''}`}
          aria-pressed={prefs.sound}
          aria-label={label}
          title={label}
          onClick={() => {
            unlockAudio();
            update({ sound: !prefs.sound });
          }}
        >
          {prefs.sound ? '🔊' : '🔇'}
        </button>
        {!embedded && (
          <a class="btn btn--sm btn--ghost" href="../">
            {t('battle.toLauncher')}
          </a>
        )}
      </div>
    </header>
  );
}

function LiveChip() {
  const ph = phase.value;
  const m = match.value;
  const p = poll.value;
  const [, force] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  if (ph !== 'live' || !m) return null;
  if (m.demo) return <span class="live-chip live-chip--demo">{t('battle.live.demo')}</span>;
  const now = Date.now();
  const stale = p.lastOkAt && now - p.lastOkAt > 5000;
  const throttled = now < p.throttledUntil + 3000;
  const cls = throttled ? 'live-chip--warn' : stale || !p.lastOkAt ? 'live-chip--wait' : '';
  const text = throttled ? t('battle.live.throttled') : !p.lastOkAt ? t('battle.live.connecting') : stale ? t('battle.live.stale') : t('battle.live.live');
  return (
    <span class={`live-chip ${cls}`} title={p.message ?? t('battle.live.target', { rate: p.rate })}>
      <span class="live-chip__dot" />
      {text}
      {!throttled && p.lastOkAt > 0 && !stale && <span class="mono">{formatNumber(p.actual, { maximumFractionDigits: 1 })}/s</span>}
    </span>
  );
}

// ------------------------------------------------------------------ Einrichtung

let autostartDone = false;

function Setup({
  prefs,
  update,
  initial,
}: {
  prefs: BattlePrefs;
  update: (p: Partial<BattlePrefs>) => void;
  initial: { autostart: boolean; demo: boolean };
}) {
  const [players, setPlayers] = useState<[Player | null, Player | null]>([null, null]);
  const [key, setKey] = useState(loadKey());
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const arming = phase.value === 'arming';

  const setPlayer = (side: Side, p: Player | null) => setPlayers((cur) => (side === 0 ? [p, cur[1]] : [cur[0], p]));
  const setName = (side: Side, name: string) => update({ names: side === 0 ? [name, prefs.names[1]] : [prefs.names[0], name] });

  async function resolveBoth(): Promise<[Player, Player] | null> {
    const out: (Player | null)[] = [...players];
    for (const side of [0, 1] as Side[]) {
      if (out[side]) continue;
      const name = prefs.names[side].trim();
      if (!name) {
        setError(t('battle.err.nameMissing', { side: sideLabel(side) }));
        return null;
      }
      const res = await findPlayer(name, key.trim() || null).catch(() => null);
      if (!res?.match) {
        setError(t('battle.err.notFound', { name }));
        return null;
      }
      out[side] = res.match;
      setPlayer(side, res.match);
    }
    if (out[0]!.id === out[1]!.id) {
      setError(t('battle.err.samePlayer'));
      return null;
    }
    return [out[0]!, out[1]!];
  }

  async function start(demo: boolean) {
    unlockAudio();
    setError(null);
    setBusy(true);
    try {
      let duo: [Player, Player] | null;
      if (demo) {
        duo = [
          players[0] ?? { id: 'demo-a', name: prefs.names[0].trim() || t('battle.demo.nameA') },
          players[1] ?? { id: 'demo-b', name: prefs.names[1].trim() || t('battle.demo.nameB') },
        ];
      } else {
        const k = key.trim();
        if (!k) {
          setError(t('battle.err.noKey'));
          return;
        }
        duo = await resolveBoth();
        if (!duo) return;
        const check = await checkKey(k);
        if (check === 'invalid') {
          setError(t('battle.err.keyRejected'));
          return;
        }
        saveKey(k, prefs.remember);
      }
      await startMatch({ players: duo, caseCode: prefs.caseCode, target: prefs.target, rate: prefs.rate, key: demo ? null : key.trim(), demo });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // Nur beim ersten Laden der Seite, nicht bei jeder Rückkehr zur Einrichtung
    if (autostartDone) return;
    autostartDone = true;
    if (initial.demo) void start(true);
    else if (initial.autostart && key && prefs.names[0] && prefs.names[1]) void start(false);
  }, []);

  const shownError = error ?? fatal.value;
  return (
    <main class="setup">
      <section class="setup__duel">
        <PlayerField side={0} name={prefs.names[0]} player={players[0]} onName={(n) => setName(0, n)} onPlayer={(p) => setPlayer(0, p)} apiKey={key} />
        <div class="setup__vs" aria-hidden="true">
          <span>VS</span>
        </div>
        <PlayerField side={1} name={prefs.names[1]} player={players[1]} onName={(n) => setName(1, n)} onPlayer={(p) => setPlayer(1, p)} apiKey={key} />
      </section>

      <section class="setup__card">
        <div class="setup__options">
          <label class="field">
            <span class="field__label">{t('battle.opt.cases')}</span>
            <select class="input" value={prefs.caseCode ?? ''} onChange={(e) => update({ caseCode: (e.currentTarget as HTMLSelectElement).value || null })}>
              {CASE_TYPES.map((c) => (
                <option value={c.code ?? ''}>{caseText(c.code, 'name')}</option>
              ))}
            </select>
          </label>
          <div class="field">
            <span class="field__label">{t('battle.opt.target')}</span>
            <div class="stepper">
              <button type="button" class="icon-btn" aria-label={t('battle.opt.fewer')} onClick={() => update({ target: clampTarget(prefs.target - 1) })}>
                −
              </button>
              <span class="stepper__value mono" aria-live="polite">
                {prefs.target}
              </span>
              <button type="button" class="icon-btn" aria-label={t('battle.opt.more')} onClick={() => update({ target: clampTarget(prefs.target + 1) })}>
                +
              </button>
            </div>
          </div>
          <label class="field">
            <span class="field__label">{t('battle.opt.rate')}</span>
            <select class="input" value={String(prefs.rate)} onChange={(e) => update({ rate: Number((e.currentTarget as HTMLSelectElement).value) })}>
              {RATES.map((r) => (
                <option value={String(r)}>{r === 8 ? t('battle.opt.rateMax', { rate: r }) : t('battle.opt.rateValue', { rate: r })}</option>
              ))}
            </select>
          </label>
        </div>

        <div class="field">
          <span class="field__label">{t('battle.key.label')}</span>
          <div class="key-row">
            <input
              class="input mono"
              type={showKey ? 'text' : 'password'}
              autocomplete="off"
              spellcheck={false}
              placeholder={t('battle.key.placeholder')}
              aria-label={t('battle.key.label')}
              value={key}
              onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)}
            />
            <button type="button" class="btn btn--sm btn--ghost" onClick={() => setShowKey(!showKey)}>
              {showKey ? t('battle.key.hide') : t('battle.key.show')}
            </button>
            {key && (
              <button
                type="button"
                class="btn btn--sm btn--ghost btn--danger-text"
                onClick={() => {
                  setKey('');
                  saveKey('', false);
                }}
              >
                {t('battle.key.forget')}
              </button>
            )}
          </div>
          <label class="check">
            <input type="checkbox" checked={prefs.remember} onChange={(e) => update({ remember: (e.currentTarget as HTMLInputElement).checked })} />
            {t('battle.key.remember')}
          </label>
          <p class="hint">{t('battle.key.hint')}</p>
        </div>

        {shownError && (
          <p class="setup__error" role="alert">
            {shownError}
          </p>
        )}

        <div class="setup__actions">
          <button type="button" class="btn btn--primary btn--big" data-action="start" disabled={busy || arming} onClick={() => void start(false)}>
            {arming ? t('battle.start.arming') : busy ? t('battle.start.checking') : t('battle.start.go')}
          </button>
          <button type="button" class="btn btn--ghost" data-action="demo" disabled={busy || arming} onClick={() => void start(true)}>
            {t('battle.start.demo')}
          </button>
        </div>
      </section>

      <section class="setup__rules">
        <h2>{t('battle.rules.title')}</h2>
        <ol>
          <li>{t('battle.rules.setup')}</li>
          <li>{t('battle.rules.turns', { cases: caseText(prefs.caseCode, 'plural'), first: sideLabel(0) })}</li>
          <li>{t('battle.rules.rarity', { order: RARITIES.map((r) => rarityLabel(r)).join(' < ') })}</li>
          <li>{tn('battle.rules.win', prefs.target)}</li>
        </ol>
        <p class="hint">{t('battle.rules.limit')}</p>
      </section>
    </main>
  );
}

function PlayerField({
  side,
  name,
  player,
  onName,
  onPlayer,
  apiKey,
}: {
  side: Side;
  name: string;
  player: Player | null;
  onName: (n: string) => void;
  onPlayer: (p: Player | null) => void;
  apiKey: string;
}) {
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = name.trim();
    if (player && player.name.toLowerCase() === q.toLowerCase()) return;
    onPlayer(null);
    setLookup(null);
    if (q.length < 2) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      setSearching(true);
      findPlayer(q, apiKey.trim() || null)
        .then((res) => {
          if (id !== seq.current) return;
          setLookup(res);
          if (res.match) onPlayer(res.match);
        })
        .catch(() => id === seq.current && setLookup({ match: null, suggestions: [] }))
        .finally(() => id === seq.current && setSearching(false));
    }, 450);
    return () => clearTimeout(timer);
  }, [name]);

  return (
    <div class={`pfield pfield--${side}`}>
      <span class="pfield__side">{t('battle.player', { side: sideLabel(side) })}</span>
      <div class="pfield__row">
        <Avatar player={player} side={side} size={52} />
        <input
          class="input pfield__input"
          data-side={side}
          placeholder={side === 0 ? t('battle.field.placeholderA') : t('battle.field.placeholderB')}
          value={name}
          aria-label={t('battle.field.aria', { side: sideLabel(side) })}
          onInput={(e) => onName((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <div class="pfield__status">
        {player ? (
          <span class="pfield__ok">
            ✓ {player.name}
            {player.level ? ` · ${t('battle.field.level', { level: player.level })}` : ''}
          </span>
        ) : searching ? (
          <span class="muted">{t('battle.field.searching')}</span>
        ) : lookup && lookup.suggestions.length ? (
          <div class="pfield__suggest">
            {lookup.suggestions.map((s) => (
              <button
                type="button"
                class="chip"
                onClick={() => {
                  onPlayer(s);
                  onName(s.name);
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : lookup ? (
          <span class="muted">{t('battle.field.notFound')}</span>
        ) : null}
      </div>
    </div>
  );
}

function Avatar({ player, side, size = 64 }: { player: Player | null | undefined; side: Side; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initial = (player?.name ?? '?').slice(0, 1).toUpperCase();
  return (
    <span class={`avatar avatar--${side}`} style={{ width: `${size}px`, height: `${size}px` }}>
      {player?.avatarUrl && !broken ? (
        <img src={player.avatarUrl} alt="" referrerpolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <span class="avatar__initial" style={{ fontSize: `${size * 0.42}px` }}>
          {initial}
        </span>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ Arena

function Arena({ prefs }: { prefs: BattlePrefs }) {
  const m = match.value!;
  const s = standing.value;
  const ph = phase.value;
  const ref = useRef<HTMLElement>(null);

  // Erdbeben bei legendär und mythisch
  useSignalEffect(() => {
    const b = banner.value;
    const el = ref.current;
    if (!b || !el) return;
    el.classList.remove('quake');
    void el.offsetWidth;
    el.classList.add('quake');
  });

  const roundNo = s.winner !== null ? s.rounds.length : s.rounds.length + 1;
  const tie = slots.value[0].kind === 'open' && (slots.value[0] as { result?: string }).result === 'tie';

  return (
    <main class="arena" ref={ref} data-case={m.caseCode ?? 'any'}>
      <div class="arena__meta">
        <span class="badge badge--accent">{t('battle.arena.round', { n: roundNo })}</span>
        <span class="badge">{tn('battle.arena.firstTo', m.target)}</span>
        <span class="badge">{caseText(m.caseCode, 'short')}</span>
        {m.demo && <span class="badge badge--warn">{t('battle.arena.demo')}</span>}
        {ph === 'arming' && <span class="badge badge--accent">{t('battle.arena.arming')}</span>}
      </div>

      <div class="arena__duel">
        <PlayerPanel side={0} />
        <div class="arena__center">
          <div class={`vs-orb ${ph === 'live' ? 'is-live' : ''}`}>VS</div>
          <div class="arena__score mono" aria-label={t('battle.arena.score', { a: s.points[0], b: s.points[1] })}>
            <span class={`score--0 ${s.points[0] > s.points[1] ? 'is-ahead' : ''}`}>{s.points[0]}</span>
            <span class="score__sep">:</span>
            <span class={`score--1 ${s.points[1] > s.points[0] ? 'is-ahead' : ''}`}>{s.points[1]}</span>
          </div>
          {tie && <div class="tie-stamp">{t('battle.arena.tie')}</div>}
        </div>
        <PlayerPanel side={1} />
      </div>

      <History />

      <div class="arena__actions">
        {ph === 'live' ? (
          <button type="button" class="btn btn--ghost" onClick={() => stopMatch()}>
            {t('battle.arena.abort')}
          </button>
        ) : (
          <>
            <button type="button" class="btn btn--primary" onClick={() => void rematch(prefs)}>
              {t('battle.arena.rematch')}
            </button>
            <button type="button" class="btn btn--ghost" onClick={() => stopMatch()}>
              {t('battle.arena.newPlayers')}
            </button>
          </>
        )}
        <ShareButton />
      </div>
    </main>
  );
}

async function rematch(prefs: BattlePrefs): Promise<void> {
  const m = match.value;
  if (!m) return;
  unlockAudio();
  await startMatch({ players: m.players, caseCode: m.caseCode, target: m.target, rate: prefs.rate, key: m.demo ? null : loadKey(), demo: m.demo });
}

function ShareButton() {
  const [done, setDone] = useState(false);
  const m = match.value;
  if (!m) return null;
  const share = async () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('a', m.players[0].name);
    url.searchParams.set('b', m.players[1].name);
    url.searchParams.set('ziel', String(m.target));
    if (m.caseCode !== 'case2') url.searchParams.set('kiste', m.caseCode ?? 'alle');
    try {
      await navigator.clipboard.writeText(url.href);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      prompt(t('battle.share.prompt'), url.href);
    }
  };
  return (
    <button type="button" class="btn btn--ghost" onClick={() => void share()} title={t('battle.share.title')}>
      {done ? t('battle.share.copied') : t('battle.share.copy')}
    </button>
  );
}

function PlayerPanel({ side }: { side: Side }) {
  const m = match.value!;
  const s = standing.value;
  const slot = slots.value[side];
  const opposite = slots.value[other(side)];
  const player = m.players[side];
  const ph = phase.value;
  const isTurn = ph === 'live' && s.turn === side && slot.kind === 'idle' && opposite.kind !== 'shake';
  const result = slot.kind === 'open' ? slot.result : undefined;
  const isWinner = s.winner === side;
  // Schon im Spiel geöffnet, aber noch nicht gezeigt (etwa mehrere Kisten auf einmal)
  const shownIdx = slot.kind === 'idle' ? -1 : m.openings[side].findIndex((o) => o.id === slot.opening.id);
  const queued = shownIdx >= 0 ? m.openings[side].length - shownIdx - 1 : backlog.value[side];
  const waitsForOther = slot.kind === 'open' && !result && opposite.kind !== 'open';

  return (
    <section class={`ppanel ppanel--${side} ${isTurn ? 'is-turn' : ''} ${result ? `is-${result}` : ''} ${isWinner ? 'is-champion' : ''}`}>
      <div class="ppanel__head">
        <Avatar player={player} side={side} size={64} />
        <div class="ppanel__who">
          <span class="ppanel__side">{sideLabel(side)}</span>
          <strong class="ppanel__name">{player.name}</strong>
          {player.level ? <span class="muted">{t('battle.field.level', { level: player.level })}</span> : null}
        </div>
      </div>
      <Pips count={m.target} filled={s.points[side]} side={side} />
      <div class="ppanel__stage">
        <CaseStage slot={slot} />
        {result === 'win' && <span class="plus-one">+1</span>}
      </div>
      <div class="ppanel__foot">
        {isTurn ? (
          <span class="turn-badge">{t('battle.panel.turn')}</span>
        ) : slot.kind === 'shake' ? (
          <span class="muted">{t('battle.panel.opening')}</span>
        ) : waitsForOther ? (
          <span class="muted">{t('battle.panel.waitsFor', { name: m.players[other(side)].name })}</span>
        ) : (
          <span class="muted">&nbsp;</span>
        )}
        {queued > 0 && ph === 'live' ? (
          <span class="badge badge--tiny" title={t('battle.panel.queuedTitle')}>
            {t('battle.panel.queued', { count: queued })}
          </span>
        ) : null}
      </div>
      <TipButton side={side} />
    </section>
  );
}

function TipButton({ side }: { side: Side }) {
  const m = match.value!;
  const s = standing.value;
  if (s.rounds.length > 0 || phase.value !== 'live') {
    return m.tip === side ? <span class="tip tip--locked">{t('battle.tip.yours')}</span> : null;
  }
  return (
    <button type="button" class={`tip ${m.tip === side ? 'is-active' : ''}`} onClick={() => setTip(m.tip === side ? null : side)} title={t('battle.tip.title')}>
      {m.tip === side ? t('battle.tip.active') : t('battle.tip.pick')}
    </button>
  );
}

function Pips({ count, filled, side }: { count: number; filled: number; side: Side }) {
  return (
    <div class={`pips pips--${side}`} aria-label={t('battle.pips', { filled, count })}>
      {Array.from({ length: count }, (_, i) => (
        <span class={`pip ${i < filled ? 'is-on' : ''}`} key={i} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Kiste

function CaseStage({ slot }: { slot: Slot }) {
  const ref = useRef<HTMLDivElement>(null);
  const opening = slot.kind === 'idle' ? null : slot.opening;
  const openId = slot.kind === 'open' ? slot.opening.id : null;

  useEffect(() => {
    if (!openId || !opening) return;
    const rank = rarityRank(opening.rarity);
    const color = opening.rarity ? RARITY_COLOR[opening.rarity] : '#a7b0c0';
    burstAt(ref.current, [color, '#ffffff', color, '#f43f5e'], 30 + Math.max(0, rank) * 22);
  }, [openId]);

  const rarity = opening?.rarity ?? null;
  const style = rarity ? ({ '--rc': RARITY_COLOR[rarity] } as Record<string, string>) : undefined;
  return (
    <div class={`case-stage is-${slot.kind} ${rarity ? `rar-${rarity}` : ''}`} style={style} ref={ref}>
      <div class="rays" aria-hidden="true" />
      <Crate state={slot.kind} />
      {slot.kind === 'open' && <ItemCard opening={slot.opening} />}
    </div>
  );
}

function Crate({ state }: { state: Slot['kind'] }) {
  return (
    <div class={`crate crate--${state}`} aria-hidden="true">
      <div class="crate__lid">
        <span class="crate__band" />
      </div>
      <div class="crate__body">
        <span class="crate__band crate__band--v" />
        <span class="crate__lock" />
      </div>
      <div class="crate__shadow" />
    </div>
  );
}

function MiniCrate() {
  return (
    <span class="mini-crate" aria-hidden="true">
      <span />
    </span>
  );
}

function ItemCard({ opening }: { opening: Opening }) {
  const stats = skillsText(opening.skills);
  return (
    <div class={`item-card ${opening.rarity ? `rar-${opening.rarity}` : 'rar-unknown'}`}>
      <span class="item-card__emoji">{itemInfo(opening.itemCode).emoji}</span>
      <strong class="item-card__name">{itemName(opening.itemCode)}</strong>
      <span class="item-card__rarity">{rarityLabel(opening.rarity)}</span>
      {stats && <span class="item-card__stats mono">{stats}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ Verlauf

function History() {
  const s = standing.value;
  const m = match.value!;
  if (!s.rounds.length) return <div class="history history--empty muted">{t('battle.history.empty')}</div>;
  return (
    <ol class="history" aria-label={t('battle.history.label')}>
      {s.rounds.map((r) => (
        <li class={`hround ${r.winner === null ? 'is-tie' : `won-${r.winner}`}`} key={r.index}>
          <span class="hround__no">R{r.index}</span>
          <HItem opening={r.a} win={r.winner === 0} />
          <span class="hround__vs">{r.winner === null ? '=' : r.winner === 0 ? '>' : '<'}</span>
          <HItem opening={r.b} win={r.winner === 1} />
          <span class="hround__who">{r.winner === null ? t('battle.arena.tie') : t('battle.history.point', { name: m.players[r.winner].name })}</span>
        </li>
      ))}
    </ol>
  );
}

function HItem({ opening, win }: { opening: Opening; win: boolean }) {
  return (
    <span class={`hitem ${opening.rarity ? `rar-${opening.rarity}` : ''} ${win ? 'is-win' : ''}`} title={`${itemName(opening.itemCode)} · ${rarityLabel(opening.rarity)}`}>
      <span>{itemInfo(opening.itemCode).emoji}</span>
      <span class="hitem__label">{rarityLabel(opening.rarity)}</span>
    </span>
  );
}

// ------------------------------------------------------------------ Sieg

function Victory({ prefs }: { prefs: BattlePrefs }) {
  const m = match.value!;
  const s = standing.value;
  const [hidden, setHidden] = useState(false);
  const winner = s.winner;
  useEffect(() => {
    if (winner === null) return;
    rain(winner === 0 ? ['#f43f5e', '#fbbf24', '#ffffff', '#fb7185'] : ['#60a5fa', '#fbbf24', '#ffffff', '#93c5fd'], 5000);
  }, [winner]);
  const best = useMemo(() => {
    if (winner === null) return null;
    const own = s.rounds.map((r) => (winner === 0 ? r.a : r.b));
    return own.sort((x, y) => rarityRank(y.rarity) - rarityRank(x.rarity))[0] ?? null;
  }, [winner, s.rounds.length]);
  if (winner === null || hidden) return null;
  const champ = m.players[winner];
  const tipText = m.tip === null ? null : m.tip === winner ? t('battle.victory.tipRight') : t('battle.victory.tipWrong');
  return (
    <div class={`victory victory--${winner}`} role="dialog" aria-modal="true" aria-labelledby="victory-title">
      <div class="victory__card">
        <div class="victory__crown" aria-hidden="true">
          👑
        </div>
        <Avatar player={champ} side={winner} size={120} />
        <p class="victory__eyebrow">{t('battle.victory.eyebrow')}</p>
        <h2 id="victory-title" class="victory__name">
          {champ.name}
        </h2>
        <p class="victory__score mono">
          {s.points[0]} : {s.points[1]}
        </p>
        <p class="muted">
          {tn('battle.victory.after', s.rounds.length)}
          {best ? ` · ${t('battle.victory.best', { item: itemName(best.itemCode), rarity: rarityLabel(best.rarity) })}` : ''}
        </p>
        {tipText && <p class="victory__tip">{tipText}</p>}
        <div class="victory__actions">
          <button type="button" class="btn btn--primary btn--big" onClick={() => void rematch(prefs)}>
            {t('battle.arena.rematch')}
          </button>
          <button type="button" class="btn btn--ghost" onClick={() => stopMatch()}>
            {t('battle.arena.newPlayers')}
          </button>
          <button type="button" class="btn btn--ghost" onClick={() => setHidden(true)}>
            {t('battle.victory.history')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Einblendungen

function Banner() {
  const b = banner.value;
  if (!b) return null;
  return (
    <div class={`big-banner big-banner--${b.tone}`} key={b.id} aria-hidden="true">
      <span>{b.tone === 'mythic' ? t('battle.banner.mythic') : t('battle.banner.legendary')}</span>
    </div>
  );
}

/** Ansage für Screenreader: was gezogen wurde und wer punktet. */
function Announcer() {
  const [text, setText] = useState('');
  useSignalEffect(() => {
    const m = match.value;
    const sl = slots.value;
    const r = lastRound.value;
    if (!m) return;
    for (const side of [0, 1] as Side[]) {
      const slot = sl[side];
      if (slot.kind === 'open' && !slot.result) {
        setText(t('battle.announce.pull', { name: m.players[side].name, item: itemName(slot.opening.itemCode), rarity: rarityLabel(slot.opening.rarity) }));
        return;
      }
    }
    if (sl[0].kind === 'open' && sl[0].result && r) {
      setText(r.winner === null ? t('battle.announce.tie', { n: r.index }) : t('battle.announce.point', { n: r.index, name: m.players[r.winner].name }));
    }
  });
  return (
    <div class="sr-only" aria-live="polite">
      {text}
    </div>
  );
}
