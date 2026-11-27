import { describe, it, expect } from 'vitest';
import {
  fillsOf,
  checkOrder,
  toEquipSale,
  summarize,
  premiumBands,
  pricePercentile,
  quantile,
  salesPerDay,
  type Order,
  type TradeTx,
  type EquipSale,
} from '../src/market/logic';
import marketMessages from '../src/i18n/messages/market';

const ME = 'me';
const NOW = Date.parse('2026-11-27T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const order = (over: Partial<Order> = {}): Order => ({
  _id: 'own',
  user: ME,
  itemCode: 'concrete',
  quantity: 100,
  price: 2,
  offerAt: hoursAgo(1),
  type: 'sell',
  ...over,
});
const other = (price: number, quantity = 50, type: 'buy' | 'sell' = 'sell', id = `o${price}${type}`): Order => ({
  _id: id,
  user: 'x',
  itemCode: 'concrete',
  quantity,
  price,
  offerAt: hoursAgo(5),
  type,
});

describe('fillsOf', () => {
  it('ordnet Handel über Ware, Seite und Angebotszeitpunkt zu', () => {
    const o = order({ offerAt: '2026-11-27T10:00:00.000Z' });
    const trades: TradeTx[] = [
      { transactionType: 'trading', itemCode: 'concrete', sellerId: ME, offerCreatedAt: o.offerAt, quantity: 10, money: 20, createdAt: '2026-11-27T11:00:00Z' },
      { transactionType: 'trading', itemCode: 'concrete', sellerId: ME, offerCreatedAt: o.offerAt, quantity: 5, money: 10, createdAt: '2026-11-27T11:30:00Z' },
      { transactionType: 'trading', itemCode: 'concrete', buyerId: ME, offerCreatedAt: o.offerAt, quantity: 99, createdAt: '2026-11-27T11:40:00Z' },
      { transactionType: 'trading', itemCode: 'iron', sellerId: ME, offerCreatedAt: o.offerAt, quantity: 99, createdAt: '2026-11-27T11:40:00Z' },
    ];
    const fills = fillsOf(o, ME, trades);
    expect(fills.map((f) => f.quantity)).toEqual([5, 10]);
  });
});

describe('checkOrder', () => {
  const base = { userId: ME, avg7: 2, volume7: 1000, fills: [], now: NOW };

  it('passt, wenn die Order vorne steht und nah am Markt liegt', () => {
    const c = checkOrder({ ...base, order: order({ price: 2 }), book: { sell: [other(2.03)], buy: [other(1.95, 50, 'buy')] } });
    expect(c.flags).toEqual([]);
    expect(c.suggestion).toBeNull();
    expect(c.ahead).toBe(0);
    expect(c.opposite).toBe(1.95);
  });

  it('meldet zu teure Verkaufsorders und schlägt den Preis knapp unter dem günstigsten vor', () => {
    const c = checkOrder({ ...base, order: order({ price: 2.2 }), book: { sell: [other(1.9, 40), other(2.0, 60)], buy: [] } });
    expect(c.flags).toContain('expensive');
    expect(c.ahead).toBe(2);
    expect(c.aheadQty).toBe(100);
    expect(c.suggestion).toBeCloseTo(1.899, 6);
    expect(c.reach).toBeCloseTo((100 + 100) / 1000, 6);
  });

  it('meldet verschenktes Geld, wenn man mit großem Abstand der Günstigste ist', () => {
    const c = checkOrder({ ...base, order: order({ price: 1.8 }), book: { sell: [other(2.0)], buy: [] } });
    expect(c.flags).toContain('cheap');
    expect(c.suggestion).toBeCloseTo(1.999, 6);
  });

  it('meldet Überschwemmung bei mehr als zwei Tagesumsätzen', () => {
    const c = checkOrder({ ...base, order: order({ quantity: 2500 }), book: { sell: [other(2.01)], buy: [] } });
    expect(c.flags).toContain('flooding');
  });

  it('meldet alte Orders ohne Füllung als liegend', () => {
    const c = checkOrder({ ...base, order: order({ offerAt: hoursAgo(72) }), book: { sell: [], buy: [] } });
    expect(c.flags).toContain('stale');
    const filled = checkOrder({
      ...base,
      order: order({ offerAt: hoursAgo(72) }),
      book: { sell: [], buy: [] },
      fills: [{ at: hoursAgo(2), quantity: 5, money: 10 }],
    });
    expect(filled.flags).not.toContain('stale');
    expect(filled.filled).toBe(5);
  });

  it('meldet überbotene und zu hoch bietende Kauforders und bleibt unter dem günstigsten Verkäufer', () => {
    const outbid = checkOrder({ ...base, order: order({ type: 'buy', price: 1.9 }), book: { buy: [other(1.95, 10, 'buy')], sell: [other(2.0)] } });
    expect(outbid.flags).toContain('outbid');
    expect(outbid.suggestion).toBeCloseTo(1.951, 6);
    const over = checkOrder({ ...base, order: order({ type: 'buy', price: 2.1 }), book: { buy: [other(1.9, 10, 'buy')], sell: [other(2.2)] } });
    expect(over.flags).toContain('overbid');
    expect(over.suggestion).toBeCloseTo(1.901, 6);
    // Vorschlag gleich dem eigenen Preis entfällt
    const tight = checkOrder({
      ...base,
      order: order({ type: 'buy', price: 0.088 }),
      book: { buy: [{ ...other(0.088, 10, 'buy'), offerAt: hoursAgo(9) }], sell: [other(0.089)] },
    });
    expect(tight.flags).toContain('outbid');
    expect(tight.suggestion).toBeNull();
  });
});

describe('Ausrüstungsverkäufe', () => {
  const tx = (over: Record<string, unknown> = {}) => ({
    _id: 's1',
    transactionType: 'itemMarket',
    sellerId: ME,
    money: 66,
    quantity: 1,
    offerCreatedAt: '2026-11-27T00:00:00Z',
    createdAt: '2026-11-27T00:30:00Z',
    marketAvgPrice: 60,
    item: { code: 'pants4', skills: { armor: 28 } },
    ...over,
  });

  it('liest Dauer und Preislage, notfalls gegen den aktuellen Durchschnitt', () => {
    expect(toEquipSale(tx(), ME)).toMatchObject({ code: 'pants4', price: 66, minutes: 30 });
    expect(toEquipSale(tx(), ME)!.premium).toBeCloseTo(0.1, 10);
    expect(toEquipSale(tx({ marketAvgPrice: undefined }), ME)!.premium).toBeNull();
    expect(toEquipSale(tx({ marketAvgPrice: undefined }), ME, 55)!.premium).toBeCloseTo(0.2, 10);
    expect(toEquipSale(tx({ sellerId: 'x' }), ME)).toBeNull();
  });

  it('fasst Verkäufe zusammen', () => {
    const sales: EquipSale[] = [10, 20, 30, 600].map((minutes, i) => ({
      id: `s${i}`,
      at: new Date(NOW - i * 86_400_000).toISOString(),
      code: 'boots2',
      price: 5,
      minutes,
      premium: [-0.2, 0, 0.05, 0.3][i],
      skills: {},
    }));
    const s = summarize(sales);
    expect(s.count).toBe(4);
    expect(s.revenue).toBe(20);
    expect(s.medianMinutes).toBe(25);
    expect(s.withinHour).toBe(0.75);
    expect(s.days).toBeCloseTo(3, 6);
    expect(premiumBands(sales).map((b) => b.count)).toEqual([1, 2, 1]);
  });

  it('ordnet einen Preis unter den Verkäufen ein', () => {
    expect(pricePercentile(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(0.45, 10);
    expect(pricePercentile(5, [])).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(salesPerDay(['2026-11-26T00:00:00Z', '2026-11-26T12:00:00Z', '2026-11-27T00:00:00Z'])).toBe(3);
  });
});

describe('Texte', () => {
  it('haben für jeden Hinweis Name und Erklärung', () => {
    for (const l of ['de', 'en', 'sv'] as const) {
      const dict = marketMessages[l] as Record<string, string>;
      for (const f of ['expensive', 'cheap', 'stale', 'flooding', 'outbid', 'overbid']) {
        expect(dict[`market.flag.${f}`], `${l}: ${f}`).toBeTruthy();
        expect(dict[`market.flag.${f}.info`], `${l}: ${f}.info`).toBeTruthy();
      }
      for (const b of ['below', 'around', 'above']) expect(dict[`market.band.${b}`]).toBeTruthy();
    }
  });
});
