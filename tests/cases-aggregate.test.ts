import { describe, it, expect } from 'vitest';
import { aggregate, type AggParams, type ComboTable } from '../src/cases/aggregate';
import { PullStore, KIND_OPEN, KIND_SCRAP, KIND_SOLD, NO_ACQ, DAY_BASE, MS_DAY } from '../src/cases/store';
import { rng, longestDrought, sinceLast } from '../src/cases/logic';
import { RARITIES, type Rarity } from '../src/battle/logic';

const rankToRarity = (r: number): Rarity | null => (r >= 0 ? RARITIES[r] : null);

interface Setup {
  store: PullStore;
  params: AggParams;
}

/** Zufälliger Speicher mit Zeitgleichständen, unbekannten Seltenheiten, allen Ergebnisarten und fehlenden Preisen. */
function makeSetup(n: number, seed: number, over: Partial<AggParams> = {}): Setup {
  const rand = rng(seed);
  const store = new PullStore(8);
  const nCombos = 40;
  const combos: ComboTable = {
    rank: new Int8Array(nCombos),
    sale: new Float32Array(nCombos),
    scrapValue: new Float32Array(nCombos),
    value: new Float32Array(nCombos),
    sell: new Uint8Array(nCombos),
  };
  const unitsByRank = [6, 18, 54, 162, 486, 1458];
  for (let c = 0; c < nCombos; c++) {
    const rank = c % 9 === 0 ? -1 : Math.floor(rand() * 6);
    combos.rank[c] = rank;
    const units = rank >= 0 ? unitsByRank[rank] : 0;
    combos.scrapValue[c] = units * 0.25;
    combos.sale[c] = rand() < 0.2 ? NaN : units * 0.25 * (0.6 + rand());
    combos.sell[c] = !Number.isNaN(combos.sale[c]) && combos.sale[c] > combos.scrapValue[c] * 1.2 ? 1 : 0;
    combos.value[c] = combos.sell[c] ? combos.sale[c] : combos.scrapValue[c];
  }
  const day0 = Math.floor(Date.UTC(2026, 10, 1) / MS_DAY) - DAY_BASE;
  for (let i = 0; i < n; i++) {
    const at = Date.UTC(2026, 10, 1) + Math.floor(rand() * 20) * MS_DAY + Math.floor(rand() * 4000) * 1000 * 21;
    const slot = store.add(at, rand() < 0.1 ? NO_ACQ : 5, rand() < 0.2 ? 1 : 0, Math.floor(rand() * nCombos), rand() < 0.3 ? 3.5 + rand() : NaN);
    const roll = rand();
    if (roll < 0.5) store.setOutcome(slot, KIND_SCRAP, unitsByRank[Math.floor(rand() * 6)], day0 + Math.floor(rand() * 20));
    else if (roll < 0.6) store.setOutcome(slot, KIND_SOLD, 5 + rand() * 90, day0 + Math.floor(rand() * 20));
  }
  store.publish();
  const days = 24;
  const costByDay: [Float32Array, Float32Array] = [new Float32Array(days), new Float32Array(days)];
  const scrapByDay = new Float32Array(days);
  for (let d = 0; d < days; d++) {
    costByDay[0][d] = d % 7 === 3 ? NaN : 3.8 + d * 0.01;
    costByDay[1][d] = d % 5 === 2 ? NaN : 25 + d * 0.2;
    scrapByDay[d] = d % 6 === 1 ? NaN : 0.24 + d * 0.001;
  }
  const params: AggParams = {
    filter: -1,
    custom: [null, null],
    current: [3.9, NaN],
    scrapNow: 0.25,
    ev: [3.6, 24],
    sd: [9, 40],
    buckets: 60,
    minDay: day0,
    costByDay,
    scrapByDay,
    unitsByRank,
    combos,
    ...over,
  };
  return { store, params };
}

/** Die einfache, objektbasierte Rechnung, so wie die frühere Auswertung sie machte. */
function reference(store: PullStore, p: AggParams) {
  const slots = Array.from({ length: store.n }, (_, i) => i)
    .sort((a, b) => store.at[a] - store.at[b] || a - b)
    .filter((s) => p.filter < 0 || store.kase[s] === p.filter);
  const rows = slots.map((slot) => {
    const c = store.kase[slot];
    const cb = store.combo[slot];
    const day = Math.floor(store.at[slot] / MS_DAY) - DAY_BASE - p.minDay;
    let cost: number = p.custom[c] ?? store.cost[slot];
    if (p.custom[c] === null && Number.isNaN(cost)) {
      cost = day >= 0 && day < p.costByDay[c].length ? p.costByDay[c][day] : NaN;
      if (Number.isNaN(cost)) cost = p.current[c];
    }
    const kind = store.kind[slot];
    let value: number;
    if (kind === KIND_OPEN) value = p.combos.value[cb];
    else if (kind === KIND_SOLD) value = store.amount[slot];
    else {
      const d = store.oday[slot] - p.minDay;
      let sp = d >= 0 && d < p.scrapByDay.length ? p.scrapByDay[d] : NaN;
      if (Number.isNaN(sp)) sp = p.scrapNow;
      value = store.amount[slot] * sp;
    }
    return { slot, c, cb, cost, value, kind, rank: p.combos.rank[cb] };
  });
  return rows;
}

function check(setup: Setup) {
  const { store, params: p } = setup;
  const rows = reference(store, p);
  const a = aggregate(store, p);
  const n = rows.length;

  expect(a.n).toBe(n);
  expect(a.count).toEqual([rows.filter((r) => r.c === 0).length, rows.filter((r) => r.c === 1).length]);
  expect(a.cost).toBeCloseTo(rows.reduce((s, r) => s + (Number.isNaN(r.cost) ? 0 : r.cost), 0), 6);
  expect(a.costMissing).toBe(rows.filter((r) => Number.isNaN(r.cost)).length);
  expect(a.expected).toBeCloseTo(rows.reduce((s, r) => s + p.ev[r.c], 0), 6);
  expect(a.scrapAll).toBeCloseTo(rows.reduce((s, r) => s + p.combos.scrapValue[r.cb], 0), 6);
  expect(a.saleAll).toBeCloseTo(
    rows.reduce((s, r) => s + (Number.isNaN(p.combos.sale[r.cb]) ? p.combos.scrapValue[r.cb] : p.combos.sale[r.cb]), 0),
    6,
  );
  expect(a.value).toBeCloseTo(rows.reduce((s, r) => s + r.value, 0), 6);
  expect(a.sold).toBe(rows.filter((r) => r.kind === KIND_SOLD).length);
  expect(a.scrapped).toBe(rows.filter((r) => r.kind === KIND_SCRAP).length);
  const sells = rows.filter((r) => p.combos.sell[r.cb] === 1);
  expect(a.sellCount).toBe(sells.length);
  expect(a.scrapCount).toBe(n - sells.length);
  expect(Array.from(a.sellSlots)).toEqual(sells.map((r) => r.slot));
  expect(a.scrapUnits).toBe(rows.filter((r) => p.combos.sell[r.cb] !== 1).reduce((s, r) => s + (r.rank >= 0 ? (p.unitsByRank[r.rank] as number) : 0), 0));

  // Seltenheiten, Glück, Durststrecken, Zellband
  for (let r = 0; r < 6; r++) expect(a.rarity[r]).toBe(rows.filter((x) => x.rank === r).length);
  expect(a.unknown).toBe(rows.filter((x) => x.rank < 0).length);
  expect(a.luckScore).toBe(rows.reduce((s, r) => s + (r.rank >= 0 ? 6 * 3 ** r.rank : 0), 0));
  const asPulls = rows.map((r) => ({ rarity: rankToRarity(r.rank) }));
  expect(a.rare).toEqual({ since: sinceLast(asPulls, 'rare'), longest: longestDrought(asPulls, 'rare') });
  expect(a.epic).toEqual({ since: sinceLast(asPulls, 'epic'), longest: longestDrought(asPulls, 'epic') });
  expect(Array.from(a.strip)).toEqual(rows.map((r) => r.rank + 1));

  // Gruppen der Schrott-Empfehlungen
  const groups = { count: new Array(7).fill(0), units: new Array(7).fill(0), done: new Array(7).fill(0) };
  for (const r of rows) {
    if (p.combos.sell[r.cb] === 1) continue;
    groups.count[r.rank + 1]++;
    groups.units[r.rank + 1] += r.rank >= 0 ? (p.unitsByRank[r.rank] as number) : 0;
    if (r.kind !== KIND_OPEN) groups.done[r.rank + 1]++;
  }
  expect(a.scrapGroups).toEqual(groups);

  // Verlauf: volle Reihen und daraus die Fächer
  const actual = [0];
  const exp = [0];
  const lo = [0];
  const hi = [0];
  let act = 0;
  let ex = 0;
  let variance = 0;
  for (const r of rows) {
    const cost = Number.isNaN(r.cost) ? 0 : r.cost;
    act += r.value - cost;
    ex += p.ev[r.c] - cost;
    variance += p.sd[r.c] ** 2;
    actual.push(act);
    exp.push(ex);
    lo.push(ex - Math.sqrt(variance));
    hi.push(ex + Math.sqrt(variance));
  }
  const s = a.series;
  expect(s.n).toBe(n);
  expect(s.buckets).toBe(Math.min(p.buckets, n));
  expect(s.end[0]).toBe(0);
  expect(s.end[s.buckets]).toBe(n);
  for (let b = 0; b < s.buckets; b++) {
    expect(s.end[b + 1]).toBeGreaterThan(s.end[b]); // jedes Fach enthält mindestens eine Ziehung
    const from = s.end[b];
    const to = s.end[b + 1];
    expect(s.actual[b + 1]).toBeCloseTo(actual[to], 6);
    expect(s.expected[b + 1]).toBeCloseTo(exp[to], 6);
    expect(s.lo[b + 1]).toBeCloseTo(lo[to], 6);
    expect(s.hi[b + 1]).toBeCloseTo(hi[to], 6);
    const inside = actual.slice(from, to + 1); // Anfangswert des Fachs und alle Werte darin
    expect(s.min[b]).toBeCloseTo(Math.min(...inside), 6);
    expect(s.max[b]).toBeCloseTo(Math.max(...inside), 6);
  }
  // Fächer sind gleichmäßig verteilt
  if (s.buckets > 0) {
    const sizes = Array.from({ length: s.buckets }, (_, b) => s.end[b + 1] - s.end[b]);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  }
}

describe('aggregate: Vergleich mit der einfachen Rechnung', () => {
  it('stimmt bei allen Kisten überein', () => check(makeSetup(3000, 1)));
  it('stimmt je Kistenart überein', () => {
    check(makeSetup(3000, 2, { filter: 0 }));
    check(makeSetup(3000, 3, { filter: 1 }));
  });
  it('stimmt mit eigenen Kistenpreisen, fehlenden Tagesmitteln und ohne aktuellen Preis überein', () => {
    check(makeSetup(2500, 4, { custom: [3.7, null] }));
    check(makeSetup(2500, 5, { custom: [null, 27.5] }));
    check(makeSetup(2500, 6, { current: [NaN, NaN] }));
  });
  it('stimmt bei weniger Ziehungen als Fächern, bei wenigen und ohne Ziehungen überein', () => {
    check(makeSetup(40, 7, { buckets: 100 }));
    check(makeSetup(1, 8));
    check(makeSetup(2, 9, { buckets: 1 }));
    const empty = makeSetup(0, 10);
    const a = aggregate(empty.store, empty.params);
    expect(a.n).toBe(0);
    expect(a.series.buckets).toBe(0);
    expect(a.strip.length).toBe(0);
    expect(a.rare).toEqual({ since: 0, longest: 0 });
  });
  it('stimmt auch mit vielen Fächern und nach mehrfachem Veröffentlichen überein', () => {
    const setup = makeSetup(1500, 11, { buckets: 1200 });
    // weitere Ziehungen nachträglich, auch zeitlich mitten dazwischen
    const rand = rng(12);
    for (let i = 0; i < 800; i++) setup.store.add(Date.UTC(2026, 10, 1) + Math.floor(rand() * 20 * MS_DAY), 5, 0, Math.floor(rand() * 40), NaN);
    setup.store.publish();
    check(setup);
  });
  it('lässt unveröffentlichte Ziehungen außer Acht', () => {
    const setup = makeSetup(500, 13);
    const before = aggregate(setup.store, setup.params);
    setup.store.add(Date.UTC(2026, 10, 30), 5, 0, 1, NaN);
    expect(aggregate(setup.store, setup.params).n).toBe(before.n);
    setup.store.publish();
    expect(aggregate(setup.store, setup.params).n).toBe(before.n + 1);
  });
});

describe('aggregate: Menge', () => {
  it('wertet eine Million Ziehungen in unter einer Sekunde aus', () => {
    const N = 1_000_000;
    const base = makeSetup(10, 21, { buckets: 1200 });
    const store = new PullStore(1024);
    const rand = rng(5);
    const t0 = Date.UTC(2026, 10, 1);
    for (let i = 0; i < N; i++) {
      const slot = store.add(t0 + i * 2500, 5, i % 200 === 0 ? 1 : 0, i % 40, NaN);
      if (i % 20 !== 19) store.setOutcome(slot, KIND_SCRAP, 18, base.params.minDay + (i % 20));
      void rand;
    }
    store.publish();
    const started = performance.now();
    const a = aggregate(store, { ...base.params, buckets: 1200 });
    const elapsed = performance.now() - started;
    expect(a.n).toBe(N);
    expect(a.series.buckets).toBe(1200);
    expect(a.strip.length).toBe(N);
    expect(a.sold + a.scrapped).toBe(N - N / 20);
    expect(elapsed).toBeLessThan(1000);
  }, 60_000);
});
