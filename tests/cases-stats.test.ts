import { describe, it, expect, beforeEach } from 'vitest';
import { clearSession, getStore, market, sales, averages, storeVersion } from '../src/cases/engine';
import { aggregates, totals, rarityTable, droughts, series, strip, toSell, toScrap, rowAt, stripSlot, prefs, updatePrefs } from '../src/cases/stats';
import { DEFAULT_MARGIN } from '../src/cases/logic';
import { KIND_SCRAP, KIND_SOLD, NO_ACQ, dayIndex } from '../src/cases/store';
import type { Sale } from '../src/battle/logic';

const day = (d: string, avgValue: number) => ({ valueAt: `${d}T00:00:00.000Z`, avgValue, totalQuantity: 100 });

function add(at: string, over: { kase?: 0 | 1; code?: string; skills?: Record<string, number>; cost?: number } = {}): number {
  const st = getStore();
  const combo = st.dict.comboOf(st.dict.codeOf(over.code ?? 'helmet4'), over.skills ?? { criticalDamages: 60 });
  return st.add(Date.parse(at), NO_ACQ, over.kase ?? 1, combo, over.cost ?? NaN);
}

/** Bringt Hinzugefügtes in die Zeitordnung und stößt die Neuberechnung an. */
function publish(): void {
  getStore().publish();
  storeVersion.value++;
}

beforeEach(() => {
  clearSession();
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
    add('2026-11-20T10:00:00Z');
    add('2026-11-26T10:00:00Z');
    add('2026-11-22T10:00:00Z');
    publish();
    // 22.11.: kein Handel an diesem Tag, der Tag davor gilt
    expect(totals.value.cost).toBe(24 + 29 + 24);
    expect(totals.value.costMissing).toBe(0);
    expect(rowAt(getStore().order[0]).cost).toBe(24);
  });

  it('lässt live erkannte Ziehungen bei dem Preis, mit dem sie erkannt wurden', () => {
    const slot = add('2026-11-26T10:00:00Z', { cost: 31.5 });
    publish();
    expect(totals.value.cost).toBeCloseTo(31.5);
    expect(rowAt(slot).cost).toBeCloseTo(31.5);
  });

  it('nimmt den aktuellen Preis, wenn es keinen Verlauf gibt, und lässt sonst eigene Preise gewinnen', () => {
    market.value = { ...market.value, history: {} };
    const slot = add('2026-11-20T10:00:00Z');
    publish();
    expect(totals.value.cost).toBe(30);
    updatePrefs({ customPrice: { case2: 22 } });
    expect(totals.value.cost).toBe(22);
    expect(rowAt(slot).cost).toBe(22);
  });

  it('zählt Ziehungen ganz ohne Preis als fehlend', () => {
    market.value = { ...market.value, prices: {}, history: {} };
    add('2026-11-20T10:00:00Z');
    publish();
    expect(totals.value.costMissing).toBe(1);
    expect(totals.value.cost).toBe(0);
  });
});

describe('Wert je Ziehung', () => {
  it('zählt Verkäufe mit dem echten Erlös und Zerlegungen mit dem Schrottpreis ihres Tages', () => {
    const st = getStore();
    const sold = add('2026-11-20T10:00:00Z');
    const scrapped = add('2026-11-26T10:00:00Z');
    st.setOutcome(sold, KIND_SOLD, 77.7, dayIndex(Date.parse('2026-11-20T12:00:00Z')));
    st.setOutcome(scrapped, KIND_SCRAP, 162, dayIndex(Date.parse('2026-11-26T11:00:00Z')));
    publish();
    const a = rowAt(sold);
    const b = rowAt(scrapped);
    expect(a.value).toBeCloseTo(77.7, 4);
    expect(a.outcome?.kind).toBe('sold');
    expect(b.value).toBeCloseTo(162 * 0.26, 4); // Schrottpreis vom 26.11., nicht der von jetzt (0,25)
    expect(totals.value.sold).toBe(1);
    expect(totals.value.scrapped).toBe(1);
    expect(totals.value.value).toBeCloseTo(77.7 + 162 * 0.26, 3);
  });

  it('bewertet Offenes mit der Empfehlung von jetzt', () => {
    const slot = add('2026-11-26T10:00:00Z');
    publish();
    const row = rowAt(slot);
    expect(row.outcome).toBeNull();
    expect(row.advice.scrapUnits).toBe(162);
    expect(row.value).toBeCloseTo(162 * 0.25, 4); // ohne Verkaufsdaten bleibt der Schrottwert
    expect(row.pull.itemCode).toBe('helmet4');
    expect(row.pull.rarity).toBe('epic');
    expect(row.pull.skills).toEqual({ criticalDamages: 60 });
  });

  it('empfiehlt den Verkauf, sobald Verkäufe des Codes eine lohnende Schätzung ergeben', () => {
    const asSales = (price: number): Sale[] => Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, at: '2026-11-26T00:00:00Z', price, skills: { criticalDamages: 60 } }));
    sales.value = { helmet4: asSales(90) };
    const slot = add('2026-11-26T10:00:00Z');
    publish();
    const row = rowAt(slot);
    expect(row.advice.action).toBe('sell');
    expect(row.valuation?.price).toBe(90);
    expect(row.value).toBe(90);
    expect(toSell.value.slots).toEqual(Uint32Array.of(slot));
    expect(totals.value.sellCount).toBe(1);
  });

  it('rechnet alles neu, wenn sich Verkäufe, Schrottpreis oder Spannen ändern', () => {
    const slot = add('2026-11-26T10:00:00Z');
    publish();
    expect(totals.value.value).toBeCloseTo(162 * 0.25, 4);
    market.value = { ...market.value, prices: { ...market.value.prices, scraps: 0.3 } };
    expect(totals.value.value).toBeCloseTo(162 * 0.3, 4);
    sales.value = { helmet4: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, at: '2026-11-26T00:00:00Z', price: 60, skills: { criticalDamages: 60 } })) };
    expect(rowAt(slot).advice.action).toBe('sell'); // 60 > 48,6 · 1,15
    updatePrefs({ margin: { pct: 100, abs: 2 } });
    expect(rowAt(slot).advice.action).toBe('scrap'); // 60 < 48,6 · 2
    expect(prefs.value.margin.pct).toBe(100);
  });

  it('bewertet neue Kombinationen, die erst später dazukommen, ohne alles neu zu rechnen', () => {
    add('2026-11-26T10:00:00Z', { code: 'chest2', skills: { armor: 9 } });
    publish();
    const before = totals.value.value;
    add('2026-11-26T11:00:00Z', { code: 'rifle', skills: { attack: 80, criticalChance: 12 } });
    publish();
    expect(totals.value.n).toBe(2);
    expect(totals.value.value).toBeCloseTo(before + 54 * 0.25, 4); // rifle ist selten: 54 Schrott
  });
});

describe('Auswertung', () => {
  it('zählt Ziehungen, Seltenheiten und Durststrecken über alle Kisten', () => {
    const codes = ['helmet1', 'helmet2', 'helmet3', 'helmet4'];
    for (let i = 0; i < 40; i++) add(`2026-11-26T10:${String(i).padStart(2, '0')}:00Z`, { code: codes[i % 4], skills: { criticalDamages: i % 5 } });
    publish();
    expect(totals.value.n).toBe(40);
    const byRarity = Object.fromEntries(rarityTable.value.map((r) => [r.rarity, r.count]));
    expect(byRarity).toMatchObject({ common: 10, uncommon: 10, rare: 10, epic: 10 });
    // Rot: Durststrecke ab Episch; jeder vierte ist episch, zuletzt war es Ziehung 40
    expect(droughts.value).toMatchObject({ min: 'epic', since: 0, longest: 3 });
  });

  it('teilt den Verlauf in Fächer, die alle Ziehungen enthalten', () => {
    for (let i = 0; i < 5000; i++) add(`2026-11-2${i % 6}T${String(i % 24).padStart(2, '0')}:00:00Z`);
    publish();
    const s = series.value;
    expect(s.n).toBe(5000);
    expect(s.buckets).toBe(1200);
    expect(s.end[s.buckets]).toBe(5000);
    expect(strip.value.length).toBe(5000);
  });

  it('filtert nach Kistenart: Summen, Zellband und Zellenzuordnung folgen', () => {
    for (let i = 0; i < 30; i++) add(`2026-11-26T10:${String(i).padStart(2, '0')}:00Z`, { kase: i % 3 === 0 ? 0 : 1, skills: { criticalDamages: i } });
    publish();
    expect(totals.value.n).toBe(30);
    updatePrefs({ filter: 'case1' });
    expect(totals.value.n).toBe(10);
    expect(totals.value.count).toEqual({ case1: 10, case2: 0 });
    expect(strip.value.length).toBe(10);
    // die dritte grüne Kiste ist die 9. Ziehung (Index 8) der zeitlichen Reihenfolge
    const st = getStore();
    expect(st.kase[stripSlot(2)]).toBe(0);
    expect(st.at[stripSlot(2)]).toBe(Date.parse('2026-11-26T10:06:00Z'));
    expect(stripSlot(10)).toBe(-1);
    updatePrefs({ filter: 'case2' });
    expect(totals.value.n).toBe(20);
    expect(getStore().kase[stripSlot(0)]).toBe(1);
  });

  it('lässt unveröffentlichte Ziehungen außer Acht und hängt neue an', () => {
    add('2026-11-26T10:00:00Z');
    publish();
    expect(totals.value.n).toBe(1);
    add('2026-11-26T11:00:00Z');
    storeVersion.value++; // ohne publish keine Zeitordnung: bleibt unsichtbar
    expect(aggregates.value.n).toBe(1);
    publish();
    expect(totals.value.n).toBe(2);
  });

  it('sortiert die Verkaufsliste nach Mehrwert und gruppiert Schrott nach Seltenheit', () => {
    sales.value = {
      helmet4: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, at: '2026-11-26T00:00:00Z', price: 80, skills: { criticalDamages: 60 } })),
      rifle: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, at: '2026-11-26T00:00:00Z', price: 140, skills: { attack: 80, criticalChance: 12 } })),
    };
    const small = add('2026-11-26T10:00:00Z');
    const large = add('2026-11-26T10:01:00Z', { code: 'tank', skills: { attack: 250, criticalChance: 45 } });
    getStore().dict.comboOf(getStore().dict.codeOf('tank'), { attack: 250, criticalChance: 45 });
    sales.value = { ...sales.value, tank: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, at: '2026-11-26T00:00:00Z', price: 900, skills: { attack: 250, criticalChance: 45 } })) };
    const common = add('2026-11-26T10:02:00Z', { code: 'helmet1', skills: { criticalDamages: 3 } });
    getStore().setOutcome(common, KIND_SCRAP, 6, dayIndex(Date.parse('2026-11-26T12:00:00Z')));
    publish();
    expect(Array.from(toSell.value.slots)).toEqual([large, small]);
    expect(toSell.value.open).toBe(2);
    getStore().setOutcome(small, KIND_SOLD, 80, dayIndex(Date.parse('2026-11-26T12:00:00Z')));
    storeVersion.value++;
    expect(toSell.value.open).toBe(1);
    const groups = toScrap.value;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ rarity: 'common', count: 1, units: 6, done: 1 });
  });
});
