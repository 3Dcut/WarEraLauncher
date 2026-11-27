import { useEffect, useState } from 'preact/hooks';
import { apiKey, setApiKey } from '../core/apiKey';
import { InfoTip } from '../ui/InfoTip';
import { t, tn, formatNumber, formatDate } from '../i18n';
import { PlayerPicker, player } from '../assist/player';
import { embedded } from '../assist/page';
import { LineChart, BarList, RarityStrip } from '../assist/charts';
import { checkKey } from '../battle/api';
import { itemInfo, RARITIES, type Rarity } from '../battle/logic';
import { itemName, rarityLabel, skillsText, money, signedMoney, valueBasis, caseLabel } from '../battle/text';
import { RARITY_COLOR } from '../battle/colors';
import {
  session,
  status,
  loading,
  keyRejected,
  startSession,
  stopSession,
  continueSession,
  clearSession,
  setKey,
  refreshOutcomes,
  stopLoading,
  continueLoading,
  LOAD_LIMIT,
  type Since,
} from './engine';
import {
  prefs,
  updatePrefs,
  totals,
  luck,
  series,
  strip,
  rarityTable,
  droughts,
  caseMarkets,
  quotes,
  scrapPrice,
  scrapTrend,
  toSell,
  toScrap,
  rowAt,
  stripSlot,
  type CaseFilter,
  type Row,
} from './stats';
import { CASE_ODDS, SINCE_OPTIONS, dayStart, isRetro, type CaseCode } from './logic';

const pct = (v: number, digits = 1) => formatNumber(v * 100, { maximumFractionDigits: digits, minimumFractionDigits: digits }) + ' %';
const unknownColor = '#6b768a';
const colorOf = (r: Rarity | null) => (r ? RARITY_COLOR[r] : unknownColor);

export function CasesApp({ demo }: { demo: boolean }) {
  const s = session.value;
  useEffect(() => setKey(apiKey.value || null), [apiKey.value]);
  return (
    <div class="a-app">
      <Header />
      {s ? <Dashboard /> : <Setup demo={demo} />}
    </div>
  );
}

function Header() {
  const s = session.value;
  return (
    <header class="a-header">
      <div class="a-brand">
        <span class="a-mark" aria-hidden="true">
          📦
        </span>
        <h1>{t('cases.title')}</h1>
        {s && <LiveChip />}
      </div>
      <div class="a-header__right">
        {s && <PlayerPicker locked />}
        {!embedded && (
          <a class="btn btn--sm btn--ghost" href="../">
            {t('assist.toLauncher')}
          </a>
        )}
      </div>
    </header>
  );
}

function LiveChip() {
  const s = session.value!;
  const st = status.value;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);
  if (!s.live) return <span class="live-chip live-chip--off">{t('cases.live.paused')}</span>;
  if (s.demo) return <span class="live-chip live-chip--demo">{t('cases.live.demo')}</span>;
  const stale = st.lastOkAt && Date.now() - st.lastOkAt > 8000;
  const cls = st.state === 'throttled' ? 'live-chip--warn' : stale || !st.lastOkAt ? 'live-chip--wait' : '';
  return (
    <span class={`live-chip ${cls}`} title={st.message ?? undefined}>
      <span class="live-chip__dot" />
      {st.state === 'throttled' ? t('cases.live.throttled') : !st.lastOkAt ? t('cases.live.connecting') : stale ? t('cases.live.stale') : t('cases.live.live')}
    </span>
  );
}

// ------------------------------------------------------------------ Einrichtung

let autoDemo = false;

/** Heutiges Datum (Ortszeit) als JJJJ-MM-TT, Obergrenze des Datumsfelds. */
function today(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function Setup({ demo }: { demo: boolean }) {
  const [since, setSince] = useState<Since>('now');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = apiKey.value;
  const p = player.value;
  const st = status.value;

  async function start(asDemo: boolean) {
    setError(null);
    if (!p) return setError(t('cases.err.noPlayer'));
    if (!asDemo) {
      if (!key) return setError(t('cases.err.noKey'));
      if (since === 'date' && dayStart(date) === null) return setError(t('cases.err.noDate'));
      setBusy(true);
      const check = await checkKey(key);
      setBusy(false);
      if (check === 'invalid') return setError(t('cases.err.keyRejected'));
    }
    setBusy(true);
    await startSession({ userId: p.id, name: p.name, since: asDemo ? 'now' : since, date, key: key || null, demo: asDemo });
    setBusy(false);
  }

  useEffect(() => {
    if (demo && !autoDemo && p) {
      autoDemo = true;
      void start(true);
    }
  }, [p?.id]);

  const shown = error ?? (st.state === 'error' ? st.message : null);
  return (
    <main class="a-setup">
      <section class="a-card a-setup__card">
        <PlayerPicker />
        <div class="a-setup__row">
          <span class="muted">{t('cases.setup.since')}</span>
          <div class="segmented a-since" role="radiogroup" aria-label={t('cases.setup.since')}>
            {SINCE_OPTIONS.map((v) => (
              <button type="button" role="radio" aria-checked={since === v} class={since === v ? 'is-active' : ''} onClick={() => setSince(v)}>
                {t(`cases.since.${v}`)}
              </button>
            ))}
          </div>
          <label class="a-date">
            <span class="muted">{t('cases.setup.date')}</span>
            <input
              class={`input mono ${since === 'date' ? 'is-active' : ''}`}
              type="date"
              max={today()}
              value={date}
              aria-label={t('cases.setup.date')}
              onInput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                setDate(v);
                setSince(v ? 'date' : 'now');
              }}
            />
          </label>
        </div>
        {since !== 'now' && (
          <p class="a-note muted a-setup__hint">
            {t('cases.setup.hint')} {since === '30d' || since === 'all' || since === 'date' ? t('cases.setup.hintLong') : ''}
          </p>
        )}
        {(!key || keyRejected.value) && (
          <div class="a-key">
            <input
              class="input mono"
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder={t('assist.key.label')}
              aria-label={t('assist.key.label')}
              value={key}
              onInput={(e) => setApiKey((e.currentTarget as HTMLInputElement).value)}
            />
            <InfoTip text={t('assist.key.tooltip')} label={t('assist.key.label')} />
          </div>
        )}
        <div class="a-setup__go">
          <button type="button" class="btn btn--primary btn--big" disabled={busy || st.state === 'arming' || !p} onClick={() => void start(false)}>
            {st.state === 'arming' || busy ? t('cases.setup.arming') : t('cases.setup.start')}
          </button>
          <button type="button" class="link-btn" onClick={() => void start(true)} disabled={busy || !p}>
            {t('cases.setup.demo')}
          </button>
        </div>
        {shown && (
          <p class="a-error" role="alert">
            {shown}
          </p>
        )}
      </section>
      <MarketCard />
    </main>
  );
}

// ------------------------------------------------------------------ Auswertung

function Dashboard() {
  const s = session.value!;
  const n = totals.value.n;
  const load = loading.value;
  const retro = !!s.range && isRetro(s.range);
  const emptyText =
    load.phase === 'loading' && s.live
      ? t('cases.empty.loading')
      : retro && load.phase === 'done'
        ? t('cases.empty.none')
        : s.live
          ? t('cases.empty.live')
          : t('cases.empty.paused');
  return (
    <main class="a-main">
      <LoadBanner />
      <Controls />
      <Kpis />
      {n === 0 ? (
        <section class="a-card a-empty">
          <p>{emptyText}</p>
          {(s.since || !retro) && (
            <p class="muted">
              {t('cases.empty.since', {
                time: formatDate(new Date(s.since ? Date.parse(s.since) : s.startedAt), retro && s.range !== '1h' ? WHEN_LONG : { hour: '2-digit', minute: '2-digit' }),
              })}
            </p>
          )}
        </section>
      ) : (
        <>
          <Course />
          <div class="a-grid">
            <Rarities />
            <MarketCard />
          </div>
          <div class="a-grid">
            <SellList />
            <ScrapList />
          </div>
          <Pulls />
        </>
      )}
    </main>
  );
}

const WHEN_LONG: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
const when = (iso: string | null) => (iso ? formatDate(new Date(Date.parse(iso)), WHEN_LONG) : '');

/** Fortschritt des Nachladens: was schon da ist, wie weit zurück es reicht, und was der Nutzer tun kann. */
function LoadBanner() {
  const s = session.value!;
  const ld = loading.value;
  if (s.demo || ld.phase === 'idle') return null;
  if (ld.phase === 'done') {
    if (!ld.pulls && !ld.truncated) return null;
    return (
      <p class="a-note muted a-loaded" role="status">
        {ld.pulls ? tn('cases.load.done', ld.pulls, { date: when(ld.oldest ?? s.since) }) : ''}
        {ld.truncated ? ` ${t('cases.load.truncated', { limit: formatNumber(LOAD_LIMIT) })}` : ''}
      </p>
    );
  }
  if (ld.phase === 'error') {
    return (
      <section class="a-card a-load is-error" role="alert">
        <div class="a-load__row">
          <span class="a-error">{t('cases.load.error', { message: ld.message ?? '' })}</span>
          <button type="button" class="btn btn--sm" onClick={() => continueLoading()}>
            {t('cases.load.retry')}
          </button>
        </div>
      </section>
    );
  }
  if (ld.phase === 'stopped' || !s.live) {
    return (
      <section class="a-card a-load" role="status">
        <div class="a-load__row">
          <span class="a-load__text">
            {ld.phase === 'stopped' ? tn('cases.load.stopped', ld.pulls) : t('cases.load.paused')}
          </span>
          {ld.phase === 'stopped' && (
            <button type="button" class="btn btn--sm" onClick={() => continueLoading()}>
              {t('cases.load.continue')}
            </button>
          )}
        </div>
      </section>
    );
  }
  const pct = ld.fraction === null ? null : Math.min(100, Math.floor(ld.fraction * 100));
  return (
    <section class="a-card a-load" role="status" aria-live="polite">
      <div class="a-load__row">
        <span class="a-load__text">{ld.pulls ? tn('cases.load.running', ld.pulls) : t('cases.load.starting')}</span>
        {pct !== null && <strong class="mono">{t('cases.load.percent', { pct: formatNumber(pct) })}</strong>}
        <InfoTip text={t('cases.load.info')} label={t('cases.load.starting')} />
        <button type="button" class="btn btn--sm btn--ghost a-load__stop" onClick={() => stopLoading()}>
          {t('cases.load.stop')}
        </button>
      </div>
      <div
        class={`a-progress ${pct === null ? 'is-indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-label={t('cases.load.starting')}
      >
        <i style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </section>
  );
}

function Controls() {
  const s = session.value!;
  const p = prefs.value;
  const count = totals.value;
  const all = count.count;
  return (
    <div class="a-controls">
      <div class="segmented" role="radiogroup" aria-label={t('cases.filter.label')}>
        {(['all', 'case2', 'case1'] as CaseFilter[]).map((f) => (
          <button type="button" role="radio" aria-checked={p.filter === f} class={p.filter === f ? 'is-active' : ''} onClick={() => updatePrefs({ filter: f })}>
            {f === 'all' ? t('cases.filter.all') : caseLabel(f)}
            {f !== 'all' && p.filter === 'all' && all[f] > 0 ? <span class="muted"> {formatNumber(all[f])}</span> : null}
          </button>
        ))}
      </div>
      <MarginEditor />
      <div class="a-controls__end">
        {s.live ? (
          <button type="button" class="btn btn--sm btn--ghost" onClick={() => stopSession()}>
            {t('cases.session.pause')}
          </button>
        ) : (
          <>
            <button type="button" class="btn btn--sm" onClick={() => continueSession(apiKey.value || null)}>
              {t('cases.session.continue')}
            </button>
            {!s.demo && (
              <button type="button" class="btn btn--sm btn--ghost" title={t('cases.session.refreshTitle')} onClick={() => void refreshOutcomes()}>
                ↻
              </button>
            )}
          </>
        )}
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          onClick={() => {
            if (!totals.value.n || confirm(t('cases.session.newConfirm'))) clearSession();
          }}
        >
          {t('cases.session.new')}
        </button>
      </div>
    </div>
  );
}

function NumberField({ value, onChange, step, label, suffix }: { value: number; onChange: (v: number) => void; step: number; label: string; suffix?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label class="a-num">
      <input
        class="input mono"
        type="number"
        min={0}
        step={step}
        value={text}
        aria-label={label}
        onInput={(e) => {
          const raw = (e.currentTarget as HTMLInputElement).value;
          setText(raw);
          const v = Number(raw.replace(',', '.'));
          if (raw !== '' && Number.isFinite(v) && v >= 0) onChange(v);
        }}
      />
      {suffix && <span class="muted">{suffix}</span>}
    </label>
  );
}

function MarginEditor() {
  const m = prefs.value.margin;
  const set = (patch: Partial<typeof m>) => updatePrefs({ margin: { ...m, ...patch } });
  return (
    <div class="a-margin">
      <span class="muted">{t('cases.margin.lead')}</span>
      <NumberField value={m.pct} step={5} onChange={(v) => set({ pct: v })} label={t('cases.margin.pct')} suffix="%" />
      <span class="muted">{t('cases.margin.and')}</span>
      <NumberField value={m.abs} step={0.5} onChange={(v) => set({ abs: v })} label={t('cases.margin.abs')} />
      <span class="muted">{t('cases.margin.tail')}</span>
      <InfoTip text={t('cases.margin.info')} label={t('cases.margin.pct')} />
    </div>
  );
}

function Kpis() {
  const x = totals.value;
  const l = luck.value;
  const net = x.net;
  const real = x.sold + x.scrapped;
  return (
    <>
      <section class="a-kpis">
        <Kpi
          label={t('cases.kpi.cases')}
          value={formatNumber(x.n)}
          sub={`${caseLabel('case2')} ${formatNumber(x.count.case2)} · ${caseLabel('case1')} ${formatNumber(x.count.case1)}`}
        />
        <Kpi
          label={t('cases.kpi.cost')}
          value={money(x.cost)}
          sub={x.costMissing ? tn('cases.kpi.costMissing', x.costMissing) : t('cases.kpi.costSub')}
          info={t('cases.kpi.costInfo')}
        />
        <Kpi label={t('cases.kpi.expected')} value={money(x.expected)} sub={signedMoney(x.expected - x.cost)} info={t('cases.kpi.expectedInfo')} />
        <Kpi
          label={t('cases.kpi.value')}
          value={money(x.value)}
          sub={t('cases.kpi.valueSub', { scrap: money(x.scrapAll), sale: money(x.saleAll) })}
          info={t('cases.kpi.valueInfo')}
        />
        <Kpi label={t('cases.kpi.net')} value={signedMoney(net)} tone={x.n ? (net >= 0 ? 'plus' : 'minus') : undefined} sub={x.cost ? pct(net / x.cost) : '–'} />
        <Kpi
          label={t('cases.kpi.luck')}
          value={l.percentile === null ? '–' : luckText(l.percentile)}
          sub={l.percentile === null ? '' : luckWord(l.percentile)}
          info={t('cases.kpi.luckInfo')}
        />
      </section>
      {real > 0 && (
        <p class="a-note muted a-real">
          {tn('cases.kpi.real', x.n, { real: formatNumber(real), scrapped: formatNumber(x.scrapped), sold: formatNumber(x.sold) })}
        </p>
      )}
    </>
  );
}

function luckText(p: number): string {
  return p >= 0.5
    ? t('cases.luck.top', { pct: formatNumber(Math.max(0.1, (1 - p) * 100), { maximumFractionDigits: (1 - p) * 100 < 1 ? 1 : 0 }) })
    : t('cases.luck.bottom', { pct: formatNumber(Math.max(0.1, p * 100), { maximumFractionDigits: p * 100 < 1 ? 1 : 0 }) });
}

function luckWord(p: number): string {
  if (p >= 0.99) return t('cases.luck.w5');
  if (p >= 0.9) return t('cases.luck.w4');
  if (p >= 0.65) return t('cases.luck.w3');
  if (p > 0.35) return t('cases.luck.w2');
  if (p > 0.1) return t('cases.luck.w1');
  return t('cases.luck.w0');
}

function Kpi({ label, value, sub, info, tone }: { label: string; value: string; sub?: string; info?: string; tone?: 'plus' | 'minus' }) {
  return (
    <div class={`a-kpi ${tone ? `is-${tone}` : ''}`}>
      <span class="a-kpi__label">
        {label}
        {info && <InfoTip text={info} label={label} />}
      </span>
      <strong class="a-kpi__value">{value}</strong>
      {sub ? <span class="a-kpi__sub muted">{sub}</span> : null}
    </div>
  );
}

function Course() {
  const sr = series.value;
  return (
    <section class="a-card">
      <h2 class="a-h2">{t('cases.course.title')}</h2>
      <LineChart
        end={sr.end}
        series={[
          { label: t('cases.course.actual'), values: sr.actual, min: sr.min, max: sr.max, tone: 'accent' },
          { label: t('cases.course.expected'), values: sr.expected, tone: 'muted' },
        ]}
        band={{ lo: sr.lo, hi: sr.hi, label: t('cases.course.band') }}
        format={(v) => signedMoney(v)}
        axisFormat={(v) => formatNumber(v, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2, signDisplay: 'exceptZero' }).replace('-', '−')}
        xLabel={(count) => tn('cases.course.after', count)}
      />
    </section>
  );
}

function Rarities() {
  const table = rarityTable.value;
  const n = totals.value.n;
  const d = droughts.value;
  return (
    <section class="a-card">
      <h2 class="a-h2">{t('cases.rarity.title')}</h2>
      <BarList
        legend={[t('cases.rarity.observed'), t('cases.rarity.expected')]}
        rows={table.map((r) => ({
          key: r.rarity,
          label: rarityLabel(r.rarity),
          value: n ? r.count / n : 0,
          expected: n ? r.expected / n : 0,
          color: RARITY_COLOR[r.rarity],
          valueText: formatNumber(r.count),
          tip: (
            <>
              <strong>{formatNumber(r.count)}</strong> {t('cases.rarity.tipOf', { expected: formatNumber(r.expected, { maximumFractionDigits: 1 }) })}
              <span class="muted">
                {r.count >= r.expected ? t('cases.rarity.tipMore', { chance: pct(r.chance) }) : t('cases.rarity.tipLess', { chance: pct(r.chance) })}
              </span>
            </>
          ),
        }))}
      />
      <p class="a-note muted">
        {t('cases.drought.line', {
          rarity: rarityLabel(d.min),
          since: formatNumber(d.since),
          longest: formatNumber(d.longest),
          gap: d.expectedGap ? formatNumber(d.expectedGap, { maximumFractionDigits: 0 }) : '–',
        })}
      </p>
    </section>
  );
}

function verdictText(v: 'buy' | 'sell' | 'open'): string {
  return t(`cases.market.verdict.${v}`);
}

function MarketCard() {
  const cm = caseMarkets.value;
  const q = quotes.value.scraps;
  const trend = scrapTrend.value;
  const sp = scrapPrice.value;
  return (
    <section class="a-card">
      <h2 class="a-h2">
        {t('cases.market.title')}
        <InfoTip text={t('cases.market.info')} label={t('cases.market.title')} />
      </h2>
      <table class="a-table">
        <thead>
          <tr>
            <th />
            <th class="num">{t('cases.market.bid')}</th>
            <th class="num">{t('cases.market.ask')}</th>
            <th class="num">{t('cases.market.ev')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cm.map((c) => (
            <tr>
              <th>
                <span class={`a-crate a-crate--${c.code}`} aria-hidden="true" /> {caseLabel(c.code)}
              </th>
              <td class="num mono">{c.quote.bid === null ? '–' : money(c.quote.bid)}</td>
              <td class="num mono">{c.quote.ask === null ? '–' : money(c.quote.ask)}</td>
              <td class="num mono" title={t('cases.market.evTitle', { scrap: money(c.value.scrapEv), share: pct(c.value.sellShare, 0) })}>
                {sp ? money(c.value.ev) : '–'}
              </td>
              <td>
                {sp > 0 && c.value.coverage > 0.5 ? (
                  <span class={`a-verdict a-verdict--${c.verdict}`} title={c.edge === null ? undefined : t('cases.market.edge', { edge: signedMoney(c.edge) })}>
                    {verdictText(c.verdict)}
                  </span>
                ) : (
                  <span class="muted">…</span>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <th>{t('cases.market.scrap')}</th>
            <td class="num mono">{q.bid === null ? '–' : money(q.bid)}</td>
            <td class="num mono">{q.ask === null ? '–' : money(q.ask)}</td>
            <td class="num mono" title={t('cases.market.avg7')}>
              {q.avg7 === null ? '–' : money(q.avg7)}
            </td>
            <td>
              {trend ? (
                <span
                  class={`a-verdict a-verdict--${trend.verdict === 'sell' ? 'sell' : trend.verdict === 'hold' ? 'buy' : 'open'}`}
                  title={t('cases.market.trend', { change: pct(trend.change) })}
                >
                  {t(`cases.market.scrap.${trend.verdict}`)}
                </span>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** Zeilen der Verkaufsliste: anfangs 12, dann in Schritten; bei zehntausenden Ziehungen wäre alles auf einmal zu viel. */
const SELL_FIRST = 12;
const SELL_STEP = 100;

function SellList() {
  const { slots, open } = toSell.value;
  const size = slots.length;
  const [limit, setLimit] = useState(SELL_FIRST);
  // Zeilen entstehen nur für die sichtbaren Einträge, nicht für alle zehntausend
  const shown = Array.from(slots.subarray(0, limit), (slot) => rowAt(slot));
  return (
    <section class="a-card">
      <h2 class="a-h2">
        {t('cases.sell.title')} <span class="muted">{formatNumber(size)}</span>
        {size > 0 && open < size && <span class="badge badge--tiny">{t('cases.sell.open', { open: formatNumber(open) })}</span>}
      </h2>
      {!size ? (
        <p class="muted">{t('cases.sell.none')}</p>
      ) : (
        <ul class="a-items">
          {shown.map((r) => (
            <SellRow row={r} key={r.pull.id} />
          ))}
        </ul>
      )}
      {size > SELL_FIRST && (
        <div class="a-more">
          {limit < size && (
            <button type="button" class="link-btn" onClick={() => setLimit(limit + SELL_STEP)}>
              {t('cases.sell.more', { count: formatNumber(Math.min(SELL_STEP, size - limit)) })}
            </button>
          )}
          {limit > SELL_FIRST && (
            <button type="button" class="link-btn" onClick={() => setLimit(SELL_FIRST)}>
              {t('cases.sell.less')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function SellRow({ row }: { row: Row }) {
  const { pull, advice, outcome, valuation } = row;
  return (
    <li class={`a-item ${outcome ? 'is-done' : ''}`} style={{ '--rc': colorOf(pull.rarity) } as Record<string, string>}>
      <span class="a-item__icon" aria-hidden="true">
        {itemInfo(pull.itemCode).emoji}
      </span>
      <span class="a-item__name">
        <strong>{itemName(pull.itemCode)}</strong>
        <span class="muted">{[rarityLabel(pull.rarity), skillsText(pull.skills)].filter(Boolean).join(' · ')}</span>
      </span>
      <span class="a-item__nums mono">
        <strong title={valueBasis(valuation)}>≈ {money(advice.sale ?? 0)}</strong>
        <span class="muted" title={t('cases.sell.floorTitle', { scrap: money(advice.scrapValue) })}>
          {t('cases.sell.floor', { price: money(advice.floor) })}
        </span>
      </span>
      <span class="a-item__state">{outcome ? (outcome.kind === 'sold' ? `✓ ${money(outcome.amount)}` : t('cases.state.scrapped')) : ''}</span>
    </li>
  );
}

function ScrapList() {
  const groups = toScrap.value;
  const x = totals.value;
  const sp = scrapPrice.value;
  return (
    <section class="a-card">
      <h2 class="a-h2">
        {t('cases.scrap.title')} <span class="muted">{formatNumber(x.scrapCount)}</span>
      </h2>
      {!groups.length ? (
        <p class="muted">{t('cases.scrap.none')}</p>
      ) : (
        <table class="a-table">
          <tbody>
            {groups.map((g) => (
              <tr>
                <th>
                  <i class="a-dot" style={{ background: colorOf(g.rarity) }} /> {rarityLabel(g.rarity)}
                </th>
                <td class="num mono">{formatNumber(g.count)}×</td>
                <td class="num mono">{formatNumber(g.units)}</td>
                <td class="num mono muted">{g.done ? t('cases.scrap.done', { done: formatNumber(g.done) }) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>{t('cases.scrap.total')}</th>
              <td />
              <td class="num mono">
                <strong>{formatNumber(x.scrapUnits)}</strong>
              </td>
              <td class="num mono">≈ {money(x.scrapUnits * sp)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      <p class="a-note muted">{t('cases.scrap.note', { price: sp ? money(sp) : '–' })}</p>
    </section>
  );
}

/** Farbe je Wert des Zellbands: Index 0 unbekannt, 1 bis 6 gewöhnlich bis mythisch. */
const RANK_COLORS = [unknownColor, ...RARITIES.map((r) => RARITY_COLOR[r])];

/** Hinweis zu einer einzelnen Ziehung. */
function pullTip(slot: number) {
  const r = rowAt(slot);
  return (
    <>
      <strong>
        {itemInfo(r.pull.itemCode).emoji} {itemName(r.pull.itemCode)}
      </strong>
      <span class="muted">
        {rarityLabel(r.pull.rarity)} · {caseLabel(r.pull.caseCode)}
      </span>
      <span class="mono">{skillsText(r.pull.skills)}</span>
      <span class="mono">
        {r.advice.action === 'sell'
          ? t('cases.pulls.sell', { price: money(r.advice.sale ?? 0) })
          : t('cases.pulls.scrap', { units: formatNumber(r.advice.scrapUnits) })}
      </span>
    </>
  );
}

/** Hinweis zu einer Zelle, die mehrere Ziehungen vertritt: Zahl, Seltenheiten und das seltenste Item. */
function groupTip(ranks: Uint8Array, from: number, count: number) {
  const tally = new Array(7).fill(0) as number[];
  let best = 0;
  let bestAt = from;
  for (let k = from; k < from + count; k++) {
    tally[ranks[k]]++;
    if (ranks[k] > best) {
      best = ranks[k];
      bestAt = k;
    }
  }
  const slot = stripSlot(bestAt);
  return (
    <>
      <strong>{tn('cases.pulls.group', count)}</strong>
      <span class="muted">
        {RARITIES.map((r, i) => (tally[i + 1] ? `${rarityLabel(r)} ${formatNumber(tally[i + 1])}` : '')).filter(Boolean).join(' · ')}
        {tally[0] ? ` · ${rarityLabel(null)} ${formatNumber(tally[0])}` : ''}
      </span>
      {slot >= 0 && best > 0 && pullTip(slot)}
    </>
  );
}

function Pulls() {
  const ranks = strip.value;
  return (
    <section class="a-card">
      <h2 class="a-h2">{t('cases.pulls.title')}</h2>
      <RarityStrip
        ranks={ranks}
        colors={RANK_COLORS}
        label={`${t('cases.pulls.title')}: ${formatNumber(ranks.length)}`}
        tip={(from, count) => (count === 1 ? pullTip(stripSlot(from)) : groupTip(ranks, from, count))}
        note={(per) => t('cases.pulls.bucket', { per: formatNumber(per) })}
        legend={(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as Rarity[])
          .filter((r) => (Object.keys(CASE_ODDS) as CaseCode[]).some((c) => CASE_ODDS[c][r] > 0))
          .map((r) => ({ label: rarityLabel(r), color: RARITY_COLOR[r] }))}
      />
    </section>
  );
}
