import { useMemo, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { getItems, getPrices, getTopOrders, type ItemInfo, type Order, type Prices } from '../warera/api';
import { load, save } from '../core/storage';
import { useVisibleInterval } from '../ui/primitives';
import { t, lang, formatNumber, compareText, type MessageKey } from '../i18n';

/** Itemcodes mit übersetztem Namen (widgets.item.<code>). */
const ITEM_CODES = new Set([
  'grain',
  'livestock',
  'fish',
  'iron',
  'lead',
  'wood',
  'limestone',
  'petroleum',
  'coca',
  'bread',
  'steak',
  'cookedFish',
  'steel',
  'concrete',
  'oil',
  'paper',
  'lightAmmo',
  'ammo',
  'heavyAmmo',
  'cocain',
  'scraps',
  'case1',
  'case2',
  'woodenCase',
]);

function itemName(code: string): string {
  return ITEM_CODES.has(code) ? t(`widgets.item.${code}` as MessageKey) : code;
}

interface Snapshot {
  t: number;
  p: Prices;
}

const HISTORY_KEY = 'market:history';

function recordSnapshot(prices: Prices): Snapshot[] {
  const history = load<Snapshot[]>(HISTORY_KEY, []);
  const last = history[history.length - 1];
  if (!last || Date.now() - last.t > 15 * 60_000) {
    history.push({ t: Date.now(), p: prices });
    while (history.length > 96) history.shift();
    save(HISTORY_KEY, history);
  }
  return history;
}

/** Wert eines Produktionspunkts: Rohstoff = Preis/PP, Produkt = (Preis − Einsatz)/PP. */
export function valuePerPoint(code: string, prices: Prices, items: Record<string, ItemInfo>): number | null {
  const item = items[code];
  const price = prices[code];
  if (!item || !item.pp || price == null) return null;
  if (item.type === 'raw') return price / item.pp;
  if (item.type === 'product' && item.needs) {
    let cost = 0;
    for (const [input, qty] of Object.entries(item.needs)) {
      if (prices[input] == null) return null;
      cost += prices[input] * qty;
    }
    return (price - cost) / item.pp;
  }
  return null;
}

type Filter = 'all' | 'raw' | 'product' | 'case';
type Sort = 'name' | 'price' | 'change' | 'value';

export function MarketWidget({ visible }: { visible: Signal<boolean> }) {
  const [prices, setPrices] = useState<Prices | null>(null);
  const [items, setItems] = useState<Record<string, ItemInfo>>({});
  const [history, setHistory] = useState<Snapshot[]>(() => load<Snapshot[]>(HISTORY_KEY, []));
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('value');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useVisibleInterval(
    () => {
      getPrices()
        .then((p) => {
          setPrices(p);
          setHistory(recordSnapshot(p));
          setError(false);
        })
        .catch(() => setError(true));
      if (!Object.keys(items).length) getItems().then(setItems).catch(() => undefined);
    },
    180_000,
    visible.value,
  );

  const rows = useMemo(() => {
    if (!prices) return [];
    const reference = history.find((h) => Date.now() - h.t < 24 * 3600_000) ?? history[0];
    return Object.entries(prices)
      .map(([code, price]) => {
        const before = reference?.p[code];
        const change = before ? (price - before) / before : null;
        const series = history.map((h) => h.p[code]).filter((v): v is number => typeof v === 'number');
        return { code, name: itemName(code), price, change, series, type: items[code]?.type ?? 'unknown', value: valuePerPoint(code, prices, items) };
      })
      .filter((r) => filter === 'all' || r.type === filter || (filter === 'case' && r.type === 'case'))
      .sort((a, b) => {
        if (sort === 'name') return compareText(a.name, b.name);
        if (sort === 'price') return b.price - a.price;
        if (sort === 'change') return (b.change ?? -Infinity) - (a.change ?? -Infinity);
        return (b.value ?? -Infinity) - (a.value ?? -Infinity);
      });
  }, [prices, items, history, filter, sort, lang.value]);

  if (!prices) return <div class="widget-empty">{error ? t('widgets.market.unreachable') : t('widgets.market.loading')}</div>;

  const sortButton = (key: Sort, label: string) => (
    <button type="button" class={`th-sort ${sort === key ? 'is-active' : ''}`} onClick={() => setSort(key)} aria-pressed={sort === key}>
      {label}
    </button>
  );

  return (
    <div class="market">
      <div class="market__filters chip-row">
        {(
          [
            ['all', t('widgets.market.filter.all')],
            ['raw', t('widgets.market.filter.raw')],
            ['product', t('widgets.market.filter.product')],
            ['case', t('widgets.market.filter.case')],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button type="button" class={`chip ${filter === key ? 'chip--active' : ''}`} onClick={() => setFilter(key)} aria-pressed={filter === key}>
            {label}
          </button>
        ))}
      </div>
      <div class="table-wrap">
        <table class="market__table">
          <thead>
            <tr>
              <th>{sortButton('name', t('widgets.market.col.item'))}</th>
              <th class="num">{sortButton('price', t('widgets.market.col.price'))}</th>
              <th class="num">{sortButton('change', t('widgets.market.col.change'))}</th>
              <th class="num" title={t('widgets.market.col.valueHint')}>
                {sortButton('value', t('widgets.market.col.value'))}
              </th>
              <th aria-label={t('widgets.market.col.history')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <>
                <tr class={`market__row ${open === r.code ? 'is-open' : ''}`} onClick={() => setOpen(open === r.code ? null : r.code)}>
                  <td>{r.name}</td>
                  <td class="num mono">{fmtPrice(r.price)}</td>
                  <td class={`num mono ${r.change == null || Math.abs(r.change) < 0.0005 ? '' : r.change > 0 ? 'up' : 'down'}`}>{fmtChange(r.change)}</td>
                  <td class="num mono">{r.value == null ? '–' : fmtPrice(r.value)}</td>
                  <td>
                    <Sparkline values={r.series} />
                  </td>
                </tr>
                {open === r.code && (
                  <tr class="market__detail">
                    <td colSpan={5}>
                      <OrderBook code={r.code} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
      <p class="widget-foot muted">
        {t('widgets.market.foot')}
      </p>
    </div>
  );
}

function OrderBook({ code }: { code: string }) {
  const [book, setBook] = useState<{ buy: Order[]; sell: Order[] } | null>(null);
  useVisibleInterval(() => void getTopOrders(code).then(setBook).catch(() => setBook({ buy: [], sell: [] })), 60_000);
  if (!book) return <div class="muted">{t('widgets.market.orderBookLoading')}</div>;
  const col = (title: string, list: Order[], tone: string) => (
    <div class={`book book--${tone}`}>
      <h4>{title}</h4>
      {list.length === 0 && <span class="muted">{t('widgets.market.none')}</span>}
      {list.map((o) => (
        <div class="book__row mono">
          <span>{fmtPrice(o.price)}</span>
          <span>{formatNumber(o.quantity)}×</span>
        </div>
      ))}
    </div>
  );
  return (
    <div class="orderbook">
      {col(t('widgets.market.buyOrders'), book.buy, 'buy')}
      {col(t('widgets.market.sellOrders'), book.sell, 'sell')}
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg class="spark" width="72" height="22" aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 70 + 1},${21 - ((v - min) / span) * 19}`).join(' ');
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg class={`spark ${rising ? 'up' : 'down'}`} width="72" height="22" viewBox="0 0 72 22" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  );
}

function fmtChange(change: number | null): string {
  if (change == null) return '–';
  const digits = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (Math.abs(change) < 0.0005) return t('widgets.market.percent', { value: `±${formatNumber(0, digits)}` });
  return t('widgets.market.percent', { value: `${change > 0 ? '+' : '−'}${formatNumber(Math.abs(change * 100), digits)}` });
}

function fmtPrice(v: number): string {
  if (Math.abs(v) >= 100) return formatNumber(v, { maximumFractionDigits: 1 });
  if (Math.abs(v) >= 1) return formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return formatNumber(v, { minimumFractionDigits: 3, maximumFractionDigits: 4 });
}
