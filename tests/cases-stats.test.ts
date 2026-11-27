import { describe, it, expect, beforeEach } from 'vitest';
import { session, market, sales, averages, type Session } from '../src/cases/engine';
import { allRows, totals, prefs, updatePrefs } from '../src/cases/stats';
import { DEFAULT_MARGIN, type Outcome, type Pull } from '../src/cases/logic';
import type { Sale } from '../src/battle/logic';

const day = (d: string, avgValue: number) => ({ valueAt: `${d}T00:00:00.000Z`, avgValue, totalQuantity: 100 });

let seq = 0;
const pull = (at: string, over: Partial<Pull> = {}): Pull => {
  const n = ++seq;
  return { id: `p${n}`, itemId: `i${n}`, at, caseCode: 'case2', itemCode: 'helmet4', rarity: 'epic', skills: { criticalDamages: 60 }, cost: null, ...over };
};

const make = (pulls: Pull[], outcomes: Record<string, Outcome> = {}): Session => ({
  userId: 'u1',
  name: 'Test',
  startedAt: Date.parse('2026-11-27T12:00:00Z'),
  since: null,
  range: '7d',
  seen: [],
  pulls,
  outcomes,
  live: false,
  demo: false,
});

beforeEach(() => {
  session.value = null;
  market.value = {
    prices: { case1: 4, case2: 30, scraps: 0.25 },
    books: {},
    history: {
      case2: [day('2026-11-20', 24), day('2026-11-25', 28), day('2026-11-26', 29)],
      case1: [day('2026-11-20', 3.8), day('2026-11-26', 3.9)],
      scraps: [day('2026-11-20', 0.2), day('2026-11-26', 0.26)],
    },
    at: Date.now(),
  };
  sales.value = {};
  averages.value = {};
  updatePrefs({ margin: { ...DEFAULT_MARGIN }, filter: 'all', customPrice: {} });
});

describe('Kosten je Ziehung', () => {
  it('bewertet nachgeladene Ziehungen mit dem Tagesmittel ihres Tages, nicht mit dem Preis von jetzt', () => {
    session.value = make([pull('2026-11-20T10:00:00Z'), pull('2026-11-26T10:00:00Z'), pull('2026-11-22T10:00:00Z')]);
    expect(allRows.value.map((r) => r.cost)).toEqual([24, 29, 24]); // 22.11.: kein Handel, der Tag davor gilt
    expect(totals.value.cost).toBe(77);
    expect(totals.value.costMissing).toBe(0);
  });

  it('lässt live erkannte Ziehungen bei dem Preis, mit dem sie erkannt wurden', () => {
    session.value = make([pull('2026-11-26T10:00:00Z', { cost: 31.5 })]);
    expect(allRows.value[0].cost).toBe(31.5);
  });

  it('nimmt den aktuellen Preis, wenn es keinen Verlauf gibt, und lässt sonst eigene Preise gewinnen', () => {
    market.value = { ...market.value, history: {} };
    session.value = make([pull('2026-11-20T10:00:00Z')]);
    expect(allRows.value[0].cost).toBe(30);
    updatePrefs({ customPrice: { case2: 22 } });
    expect(allRows.value[0].cost).toBe(22);
  });
});

describe('Wert je Ziehung', () => {
  it('zählt Verkäufe mit dem echten Erlös und Zerlegungen mit dem Schrottpreis ihres Tages', () => {
    const sold = pull('2026-11-20T10:00:00Z');
    const scrapped = pull('2026-11-26T10:00:00Z');
    session.value = make([sold, scrapped], {
      [sold.id]: { kind: 'sold', at: '2026-11-20T12:00:00Z', amount: 77.7 },
      [scrapped.id]: { kind: 'scrapped', at: '2026-11-26T11:00:00Z', amount: 162 },
    });
    const [a, b] = allRows.value;
    expect(a.value).toBe(77.7);
    expect(b.value).toBeCloseTo(162 * 0.26, 10); // Schrottpreis vom 26.11., nicht der von jetzt (0,25)
    expect(totals.value.sold).toBe(1);
    expect(totals.value.scrapped).toBe(1);
  });

  it('bewertet Offenes mit der Empfehlung von jetzt', () => {
    session.value = make([pull('2026-11-26T10:00:00Z')]);
    const row = allRows.value[0];
    expect(row.outcome).toBeNull();
    expect(row.advice.scrapUnits).toBe(162);
    expect(row.value).toBeCloseTo(162 * 0.25, 10); // ohne Verkaufsdaten bleibt der Schrottwert
  });

  it('empfiehlt den Verkauf, sobald Verkäufe des Codes eine lohnende Schätzung ergeben', () => {
    const asSales = (price: number): Sale[] => Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, at: '2026-11-26T00:00:00Z', price, skills: { criticalDamages: 60 } }));
    sales.value = { helmet4: asSales(90) };
    session.value = make([pull('2026-11-26T10:00:00Z')]);
    const row = allRows.value[0];
    expect(row.advice.action).toBe('sell');
    expect(row.valuation?.price).toBe(90);
    expect(row.value).toBe(90);
  });
});

describe('Zeilen-Cache', () => {
  it('behält Zeilen, solange sich weder Ziehung noch Ergebnis noch Preise ändern', () => {
    const a = pull('2026-11-26T10:00:00Z');
    const b = pull('2026-11-26T11:00:00Z');
    session.value = make([a, b]);
    const first = allRows.value;
    // etwas, das die Ziehungen nicht betrifft
    session.value = { ...session.value!, seen: ['x'] };
    const second = allRows.value;
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('baut nur die Zeile neu, deren Ergebnis dazukam', () => {
    const a = pull('2026-11-26T10:00:00Z');
    const b = pull('2026-11-26T11:00:00Z');
    session.value = make([a, b]);
    const first = allRows.value;
    session.value = { ...session.value!, outcomes: { [b.id]: { kind: 'scrapped', at: '2026-11-26T12:00:00Z', amount: 162 } } };
    const second = allRows.value;
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1].outcome?.kind).toBe('scrapped');
  });

  it('rechnet alles neu, wenn sich Preise, Verkäufe oder Spannen ändern', () => {
    session.value = make([pull('2026-11-26T10:00:00Z')]);
    const first = allRows.value[0];
    market.value = { ...market.value, prices: { ...market.value.prices, scraps: 0.3 } };
    const afterPrice = allRows.value[0];
    expect(afterPrice).not.toBe(first);
    expect(afterPrice.advice.scrapValue).toBeCloseTo(162 * 0.3, 10);
    sales.value = { helmet4: [{ id: 's', at: '2026-11-26T00:00:00Z', price: 5, skills: { criticalDamages: 60 } }] };
    expect(allRows.value[0]).not.toBe(afterPrice);
    const before = allRows.value[0];
    updatePrefs({ margin: { pct: 50, abs: 2 } });
    expect(allRows.value[0]).not.toBe(before);
    expect(prefs.value.margin.pct).toBe(50);
  });

  it('liefert ohne Sitzung nichts und vergisst die Zeilen', () => {
    session.value = make([pull('2026-11-26T10:00:00Z')]);
    expect(allRows.value).toHaveLength(1);
    session.value = null;
    expect(allRows.value).toEqual([]);
  });
});
