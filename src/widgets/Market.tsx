import { useMemo, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { getItems, getPrices, getTopOrders, type ItemInfo, type Order, type Prices } from '../warera/api';
import { load, save } from '../core/storage';
import { useVisibleInterval } from '../ui/primitives';

export const ITEM_NAMES: Record<string, string> = {
  grain: 'Getreide',
  livestock: 'Vieh',
  fish: 'Fisch',
  iron: 'Eisen',
  lead: 'Blei',
  wood: 'Holz',
  limestone: 'Kalkstein',
  petroleum: 'Erdöl',
  coca: 'Koka',
  bread: 'Brot',
  steak: 'Steak',
  cookedFish: 'Gebratener Fisch',
  steel: 'Stahl',
  concrete: 'Beton',
  oil: 'Öl',
  paper: 'Papier',
  lightAmmo: 'Leichte Munition',
  ammo: 'Munition',
  heavyAmmo: 'Schwere Munition',
  cocain: 'Kokain',
  scraps: 'Schrott',
  case1: 'Kiste I',
  case2: 'Kiste II',
  woodenCase: 'Holzkiste',
};

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
        return { code, name: ITEM_NAMES[code] ?? code, price, change, series, type: items[code]?.type ?? 'unknown', value: valuePerPoint(code, prices, items) };
      })
      .filter((r) => filter === 'all' || r.type === filter || (filter === 'case' && r.type === 'case'))
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, 'de');
        if (sort === 'price') return b.price - a.price;
        if (sort === 'change') return (b.change ?? -Infinity) - (a.change ?? -Infinity);
        return (b.value ?? -Infinity) - (a.value ?? -Infinity);
      });
  }, [prices, items, history, filter, sort]);

  if (!prices) return <div class="widget-empty">{error ? 'Marktdaten nicht erreichbar.' : 'Marktdaten werden geladen …'}</div>;

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
            ['all', 'Alle'],
            ['raw', 'Rohstoffe'],
            ['product', 'Produkte'],
            ['case', 'Kisten'],
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
              <th>{sortButton('name', 'Ware')}</th>
              <th class="num">{sortButton('price', 'Preis')}</th>
              <th class="num">{sortButton('change', '24 h')}</th>
              <th class="num" title="Wert pro Produktionspunkt (Produkte: Preis minus Einsatz)">
                {sortButton('value', 'Wert/PP')}
              </th>
              <th aria-label="Verlauf" />
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
        Verlauf aus lokalen Schnappschüssen (alle 15 Min., solange der Launcher offen ist). Wert/PP hilft beim Vergleich, was sich zu produzieren lohnt.
      </p>
    </div>
  );
}

function OrderBook({ code }: { code: string }) {
  const [book, setBook] = useState<{ buy: Order[]; sell: Order[] } | null>(null);
  useVisibleInterval(() => void getTopOrders(code).then(setBook).catch(() => setBook({ buy: [], sell: [] })), 60_000);
  if (!book) return <div class="muted">Orderbuch wird geladen …</div>;
  const col = (title: string, list: Order[], tone: string) => (
    <div class={`book book--${tone}`}>
      <h4>{title}</h4>
      {list.length === 0 && <span class="muted">keine</span>}
      {list.map((o) => (
        <div class="book__row mono">
          <span>{fmtPrice(o.price)}</span>
          <span>{o.quantity.toLocaleString('de-DE')}×</span>
        </div>
      ))}
    </div>
  );
  return (
    <div class="orderbook">
      {col('Kaufgebote', book.buy, 'buy')}
      {col('Verkaufsangebote', book.sell, 'sell')}
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
  if (Math.abs(change) < 0.0005) return '±0,0 %';
  return `${change > 0 ? '+' : '−'}${Math.abs(change * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

function fmtPrice(v: number): string {
  if (Math.abs(v) >= 100) return v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  if (Math.abs(v) >= 1) return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString('de-DE', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
}
