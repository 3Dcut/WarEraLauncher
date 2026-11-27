import { useEffect, useMemo, useState } from 'preact/hooks';
import { apiKey, setApiKey } from '../core/apiKey';
import { InfoTip } from '../ui/InfoTip';
import { t, tn, formatNumber, formatDate, type MessageKey } from '../i18n';
import { PlayerPicker, player } from '../assist/player';
import { embedded } from '../assist/page';
import { Scatter } from '../assist/charts';
import { fetchPrices } from '../assist/api';
import { loadItemConfig, rarityOf, statRangesOf } from '../battle/api';
import { estimateValue, itemInfo, RARITIES, SKILLS } from '../battle/logic';
import { itemName, rarityLabel, money, caseLabel, skillsText } from '../battle/text';
import { RARITY_COLOR } from '../battle/colors';
import { scrapYield, WEAPON_BY_RARITY, GEAR_SLOTS } from '../cases/logic';
import { report, loading, error, loadReport, loadCodeSales, type CodeSales } from './engine';
import { premiumBands, pricePercentile, quantile, salesPerDay, summarize, type EquipSale, type Flag, type OrderCheck } from './logic';

const pct = (v: number, digits = 0) => formatNumber(v * 100, { maximumFractionDigits: digits, signDisplay: 'exceptZero' }).replace('-', '−') + ' %';
const key = (k: string) => k as MessageKey;
/** Warenpreise haben bis zu drei Nachkommastellen (Eisen 0,088). */
const price3 = (v: number) => formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: v >= 100 ? 2 : 3 });

function goodsName(code: string): string {
  if (code === 'case1' || code === 'case2') return caseLabel(code);
  const label = t(key(`widgets.item.${code}`));
  return label === `widgets.item.${code}` ? code : label;
}

function duration(minutes: number | null): string {
  if (minutes === null) return '–';
  if (minutes < 90) return t('market.dur.min', { n: formatNumber(minutes, { maximumFractionDigits: 0 }) });
  if (minutes < 48 * 60) return t('market.dur.h', { n: formatNumber(minutes / 60, { maximumFractionDigits: 1 }) });
  return t('market.dur.d', { n: formatNumber(minutes / 1440, { maximumFractionDigits: 1 }) });
}

export function MarketApp() {
  const p = player.value;
  const k = apiKey.value;
  useEffect(() => {
    if (p) void loadReport(p.id, k || null);
  }, [p?.id, k]);
  useEffect(() => {
    void loadItemConfig();
    const id = setInterval(() => {
      const cur = player.value;
      if (cur && document.visibilityState === 'visible') void loadReport(cur.id, apiKey.value || null);
    }, 120_000);
    return () => clearInterval(id);
  }, []);
  const r = report.value && p && report.value.userId === p.id ? report.value : null;
  return (
    <div class="a-app">
      <header class="a-header">
        <div class="a-brand">
          <span class="a-mark" aria-hidden="true">
            🛒
          </span>
          <h1>{t('market.title')}</h1>
        </div>
        <div class="a-header__right">
          {p && (
            <button type="button" class="btn btn--sm btn--ghost" disabled={loading.value} onClick={() => void loadReport(p.id, apiKey.value || null)}>
              {loading.value
                ? t('market.loading')
                : r
                  ? t('market.refreshAt', { time: formatDate(r.at, { hour: '2-digit', minute: '2-digit' }) })
                  : t('market.refresh')}
            </button>
          )}
          {!embedded && (
            <a class="btn btn--sm btn--ghost" href="../">
              {t('assist.toLauncher')}
            </a>
          )}
        </div>
      </header>
      <section class="a-card a-bar">
        <PlayerPicker />
        {!k && (
          <div class="a-key">
            <input
              class="input mono"
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder={t('assist.key.label')}
              aria-label={t('assist.key.label')}
              value={k}
              onInput={(e) => setApiKey((e.currentTarget as HTMLInputElement).value)}
            />
            <InfoTip text={t('market.keyInfo')} label={t('assist.key.label')} />
          </div>
        )}
      </section>
      {error.value && (
        <p class="a-error" role="alert">
          {error.value}
        </p>
      )}
      {r && (
        <main class="a-main">
          <Kpis />
          <Orders />
          <div class="a-grid">
            <EquipSales />
            <PriceCheck />
          </div>
        </main>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Kennzahlen

function Kpis() {
  const r = report.value!;
  const flagged = r.checks.filter((c) => c.flags.length).length;
  const s = r.sales ? summarize(r.sales) : null;
  return (
    <section class="a-kpis">
      <Kpi
        label={t('market.kpi.sell')}
        value={formatNumber(r.orders.sell.length)}
        sub={t('market.kpi.sellSub', { value: money(r.orders.totalSellMoneyExpected) })}
      />
      <Kpi
        label={t('market.kpi.buy')}
        value={formatNumber(r.orders.buy.length)}
        sub={t('market.kpi.buySub', { value: money(r.orders.totalBuyMoneyInvested) })}
      />
      <Kpi
        label={t('market.kpi.flagged')}
        value={`${formatNumber(flagged)}`}
        sub={tn('market.kpi.flaggedSub', r.checks.length)}
        tone={flagged ? 'warn' : undefined}
      />
      <Kpi
        label={t('market.kpi.equip')}
        value={s ? formatNumber(s.count) : '–'}
        sub={s ? t('market.kpi.equipSub', { value: money(s.revenue) }) : t('market.kpi.needsKey')}
      />
      <Kpi
        label={t('market.kpi.duration')}
        value={s ? duration(s.medianMinutes) : '–'}
        sub={s && s.p90Minutes !== null ? t('market.kpi.durationSub', { value: duration(s.p90Minutes) }) : ''}
        info={t('market.kpi.durationInfo')}
      />
      <Kpi
        label={t('market.kpi.premium')}
        value={s && s.medianPremium !== null ? pct(s.medianPremium) : '–'}
        sub={t('market.kpi.premiumSub')}
        info={t('market.kpi.premiumInfo')}
      />
    </section>
  );
}

function Kpi({ label, value, sub, info, tone }: { label: string; value: string; sub?: string; info?: string; tone?: 'warn' }) {
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

// ------------------------------------------------------------------ Orders

const FLAG_ORDER: Flag[] = ['flooding', 'expensive', 'outbid', 'stale', 'cheap', 'overbid'];

function Orders() {
  const r = report.value!;
  const list = [...r.checks].sort(
    (a, b) => b.flags.length - a.flags.length || (a.order.type < b.order.type ? 1 : -1) || b.order.price * b.order.quantity - a.order.price * a.order.quantity,
  );
  return (
    <section class="a-card">
      <h2 class="a-h2">
        {t('market.orders.title')}
        <InfoTip text={t('market.orders.info')} label={t('market.orders.title')} />
      </h2>
      {!list.length ? (
        <p class="muted">{t('market.orders.none')}</p>
      ) : (
        <div class="a-scroll">
          <table class="a-table a-orders">
            <thead>
              <tr>
                <th>{t('market.col.item')}</th>
                <th class="num">{t('market.col.qty')}</th>
                <th class="num">{t('market.col.price')}</th>
                <th class="num">{t('market.col.best')}</th>
                <th class="num">{t('market.col.avg')}</th>
                <th class="num">{t('market.col.reach')}</th>
                <th class="num">{t('market.col.age')}</th>
                <th>{t('market.col.notes')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <OrderRow c={c} tradesLoaded={r.tradesLoaded} key={c.order._id} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!r.tradesLoaded && <p class="a-note muted">{t('market.orders.noFills')}</p>}
    </section>
  );
}

function OrderRow({ c, tradesLoaded }: { c: OrderCheck; tradesLoaded: boolean }) {
  const o = c.order;
  const flags = FLAG_ORDER.filter((f) => c.flags.includes(f));
  return (
    <tr class={flags.length ? 'is-flagged' : ''}>
      <th>
        <span class={`a-side a-side--${o.type}`}>{o.type === 'sell' ? t('market.side.sell') : t('market.side.buy')}</span> {goodsName(o.itemCode)}
      </th>
      <td class="num mono">
        {formatNumber(o.quantity)}
        {tradesLoaded && c.filled > 0 && (
          <span
            class="muted"
            title={t('market.filledTitle', {
              time: c.lastFillAt ? formatDate(Date.parse(c.lastFillAt), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–',
            })}
          >
            {' '}
            +{formatNumber(c.filled)}
          </span>
        )}
      </td>
      <td class="num mono">{price3(o.price)}</td>
      <td class="num mono" title={c.opposite !== null ? t('market.oppositeTitle', { price: price3(c.opposite) }) : undefined}>
        {c.bestOther === null ? '–' : price3(c.bestOther)}
        {c.ahead > 0 && <span class="muted"> · {tn('market.ahead', c.ahead)}</span>}
      </td>
      <td class="num mono">
        {c.avg7 === null ? '–' : price3(c.avg7)}
        {c.vsAvg !== null && (
          <span class={`a-delta ${Math.abs(c.vsAvg) < 0.03 ? '' : (o.type === 'sell') === c.vsAvg > 0 ? 'is-high' : 'is-low'}`}> {pct(c.vsAvg)}</span>
        )}
      </td>
      <td class="num mono" title={c.volume7 ? t('market.volumeTitle', { qty: formatNumber(c.volume7, { maximumFractionDigits: 0 }) }) : undefined}>
        {c.reach === null
          ? '–'
          : c.reach < 1
            ? t('market.reach.lt1')
            : t('market.reach.days', { n: formatNumber(c.reach, { maximumFractionDigits: c.reach < 10 ? 1 : 0 }) })}
      </td>
      <td class="num mono">{c.ageH === null ? '–' : duration(c.ageH * 60)}</td>
      <td>
        <span class="a-flags">
          {flags.map((f) => (
            <span class={`a-flag a-flag--${f}`} title={t(key(`market.flag.${f}.info`))}>
              {t(key(`market.flag.${f}`))}
            </span>
          ))}
          {c.suggestion !== null && <span class="a-suggest mono">→ {price3(c.suggestion)}</span>}
          {!flags.length && <span class="muted">{t('market.ok')}</span>}
        </span>
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ Ausrüstungsverkäufe

function EquipSales() {
  const r = report.value!;
  const sales = r.sales;
  if (!sales) {
    return (
      <section class="a-card">
        <h2 class="a-h2">{t('market.equip.title')}</h2>
        <p class="muted">{t('market.equip.needsKey')}</p>
      </section>
    );
  }
  const bands = premiumBands(sales);
  const points = sales.filter((s) => s.minutes !== null && s.premium !== null);
  const byCode = topCodes(sales);
  return (
    <section class="a-card">
      <h2 class="a-h2">
        {t('market.equip.title')} <span class="muted">{tn('market.equip.count', sales.length)}</span>
        <InfoTip text={t('market.equip.info')} label={t('market.equip.title')} />
      </h2>
      {!sales.length ? (
        <p class="muted">{t('market.equip.none')}</p>
      ) : (
        <>
          <Scatter
            points={points.map((s) => {
              const rar = rarityOf(s.code);
              return {
                x: Math.max(1, s.minutes!),
                y: s.premium! * 100,
                color: rar ? RARITY_COLOR[rar] : '#6b768a',
                tip: (
                  <>
                    <strong>
                      {itemInfo(s.code).emoji} {itemName(s.code)} · {money(s.price)}
                    </strong>
                    <span class="muted">{[rarityLabel(rar), skillsText(s.skills)].filter(Boolean).join(' · ')}</span>
                    <span>
                      {pct(s.premium!)} · {duration(s.minutes)}
                    </span>
                  </>
                ),
              };
            })}
            logX
            xTicks={[1, 10, 60, 600, 1440 * 3]}
            xFormat={(v) => duration(v)}
            yFormat={(v) => pct(v / 100)}
            legend={RARITIES.filter((rr) => points.some((s) => rarityOf(s.code) === rr)).map((rr) => ({ label: rarityLabel(rr), color: RARITY_COLOR[rr] }))}
          />
          <p class="a-note muted">{t('market.equip.axes')}</p>
          <table class="a-table a-bands">
            <tbody>
              {bands.map((b) => (
                <tr>
                  <th>{t(key(`market.band.${b.band}`))}</th>
                  <td class="num mono">{formatNumber(b.count)}×</td>
                  <td class="num mono">{t('market.band.median', { value: duration(b.medianMinutes) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {byCode.length > 0 && (
            <div class="a-scroll">
              <table class="a-table a-codes">
                <thead>
                  <tr>
                    <th>{t('market.col.item')}</th>
                    <th class="num">{t('market.col.sold')}</th>
                    <th class="num">{t('market.col.avgPrice')}</th>
                    <th class="num">{t('market.col.duration')}</th>
                    <th class="num">{t('market.col.premium')}</th>
                  </tr>
                </thead>
                <tbody>
                  {byCode.map((g) => (
                    <tr>
                      <th>
                        <i class="a-dot" style={{ background: g.color }} /> {itemName(g.code)} <span class="muted">{rarityLabel(rarityOf(g.code))}</span>
                      </th>
                      <td class="num mono">{formatNumber(g.count)}</td>
                      <td class="num mono">{money(g.avg)}</td>
                      <td class="num mono">{duration(g.minutes)}</td>
                      <td class="num mono">{g.premium === null ? '–' : pct(g.premium)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function topCodes(sales: EquipSale[]) {
  const groups = new Map<string, EquipSale[]>();
  for (const s of sales) groups.set(s.code, [...(groups.get(s.code) ?? []), s]);
  return [...groups.entries()]
    .map(([code, list]) => {
      const rar = rarityOf(code);
      return {
        code,
        color: rar ? RARITY_COLOR[rar] : '#6b768a',
        count: list.length,
        avg: list.reduce((s, x) => s + x.price, 0) / list.length,
        minutes: quantile(
          list.map((x) => x.minutes).filter((m): m is number => m !== null),
          0.5,
        ),
        premium: quantile(
          list.map((x) => x.premium).filter((p): p is number => p !== null),
          0.5,
        ),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

// ------------------------------------------------------------------ Preis prüfen

const codesFor = (r: (typeof RARITIES)[number]) => [WEAPON_BY_RARITY[r], ...GEAR_SLOTS.map((s) => `${s}${RARITIES.indexOf(r) + 1}`)];

function PriceCheck() {
  const k = apiKey.value;
  const [code, setCode] = useState('boots5');
  const [stats, setStats] = useState<Record<string, number>>({});
  const [price, setPrice] = useState('');
  const [data, setData] = useState<CodeSales | null>(null);
  const [busy, setBusy] = useState(false);
  const [scrapPrice, setScrapPrice] = useState<number | null>(null);
  const ranges = statRangesOf(code);

  useEffect(() => {
    void fetchPrices()
      .then((p) => setScrapPrice(p.scraps ?? null))
      .catch(() => null);
  }, []);

  useEffect(() => {
    const r = statRangesOf(code) ?? {};
    setStats(Object.fromEntries(Object.entries(r).map(([s, [lo, hi]]) => [s, Math.round((lo + hi) / 2)])));
    setData(null);
    if (!k) return;
    setBusy(true);
    let live = true;
    loadCodeSales(code, k)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ sales: [], at: Date.now() }))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [code, k, ranges ? 1 : 0]);

  const result = useMemo(() => {
    if (!data?.sales.length) return null;
    const est = estimateValue(stats, data.sales, ranges);
    const own = Number(price.replace(',', '.'));
    const hasPrice = price.trim() !== '' && Number.isFinite(own) && own > 0;
    const prices = data.sales.map((s) => s.price);
    return {
      est,
      own: hasPrice ? own : null,
      vsEst: hasPrice && est ? own / est.price - 1 : null,
      percentile: hasPrice ? pricePercentile(own, prices) : null,
      minutes: quantile(
        data.sales.map((s) => s.minutes).filter((m): m is number => m !== null),
        0.5,
      ),
      perDay: salesPerDay(data.sales.map((s) => s.at)),
      low: quantile(prices, 0.1),
      high: quantile(prices, 0.9),
    };
  }, [data, stats, price, code]);

  const rar = rarityOf(code);
  const scrap = scrapPrice ? scrapYield(rar) * scrapPrice : null;
  return (
    <section class="a-card">
      <h2 class="a-h2">
        {t('market.check.title')}
        <InfoTip text={t('market.check.info')} label={t('market.check.title')} />
      </h2>
      {!k ? (
        <p class="muted">{t('market.check.needsKey')}</p>
      ) : (
        <div class="a-check">
          <div class="a-check__inputs">
            <select class="input" value={code} aria-label={t('market.col.item')} onChange={(e) => setCode((e.currentTarget as HTMLSelectElement).value)}>
              {RARITIES.map((r) => (
                <optgroup label={rarityLabel(r)}>
                  {codesFor(r).map((c) => (
                    <option value={c}>
                      {itemInfo(c).emoji} {itemName(c)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {Object.entries(ranges ?? {}).map(([s, [lo, hi]]) => (
              <label class="a-num" title={`${lo}–${hi}`}>
                <span class="muted">{SKILLS.includes(s) ? t(key(`battle.skill.${s}`)) : s}</span>
                <input
                  class="input mono"
                  type="number"
                  min={lo}
                  max={hi}
                  value={stats[s] ?? ''}
                  onInput={(e) => setStats({ ...stats, [s]: Number((e.currentTarget as HTMLInputElement).value) })}
                />
              </label>
            ))}
            <label class="a-num">
              <span class="muted">{t('market.check.price')}</span>
              <input
                class="input mono"
                type="number"
                min={0}
                step={0.01}
                value={price}
                placeholder="–"
                onInput={(e) => setPrice((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>
          {busy ? (
            <p class="muted">{t('market.loading')}</p>
          ) : !result ? (
            <p class="muted">{t('market.check.noSales')}</p>
          ) : (
            <dl class="a-facts">
              <div>
                <dt>{t('market.check.estimate')}</dt>
                <dd class="mono">
                  <strong>{result.est ? money(result.est.price) : '–'}</strong>
                </dd>
              </div>
              {result.own !== null && (
                <div>
                  <dt>{t('market.check.yours')}</dt>
                  <dd class="mono">
                    {result.vsEst === null ? '–' : pct(result.vsEst)}
                    {result.percentile !== null && (
                      <span class="muted"> · {t('market.check.percentile', { pct: formatNumber(result.percentile * 100, { maximumFractionDigits: 0 }) })}</span>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('market.check.range')}</dt>
                <dd class="mono">{result.low === null ? '–' : `${money(result.low)} … ${money(result.high ?? result.low)}`}</dd>
              </div>
              <div>
                <dt>{t('market.check.speed')}</dt>
                <dd class="mono">
                  {duration(result.minutes)}
                  {result.perDay !== null && (
                    <span class="muted">
                      {' '}
                      · {t('market.check.perDay', { n: formatNumber(result.perDay, { maximumFractionDigits: result.perDay < 10 ? 1 : 0 }) })}
                    </span>
                  )}
                </dd>
              </div>
              {scrap !== null && (
                <div>
                  <dt>{t('market.check.scrap')}</dt>
                  <dd class="mono">
                    {money(scrap)} <span class="muted">({formatNumber(scrapYield(rar))})</span>
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
