// Abgeleitete Werte des Kisten-Assistenten: Schätzung je Ziehung, Empfehlung, Summen, Erwartung,
// Glück und Marktlage. Alles als computed, damit die Oberfläche nur abbildet.

import { signal, computed } from '@preact/signals';
import { estimateValue, rarityRank, type Rarity, type Valuation } from '../battle/logic';
import { rarityOf, statRangesOf } from '../battle/api';
import { averages, market, sales, session } from './engine';
import {
  advise,
  caseVerdict,
  CASE_CODES,
  chanceAtLeast,
  DEFAULT_MARGIN,
  longestDrought,
  luckPercentile,
  luckScore,
  rarityStats,
  recentAverage,
  sinceLast,
  valueCase,
  valueCode,
  type Advice,
  type CaseCode,
  type CaseValue,
  type CodeValue,
  type Margin,
  type Outcome,
  type Pull,
} from './logic';

// ------------------------------------------------------------------ Einstellungen

export type CaseFilter = 'all' | CaseCode;

export interface Prefs {
  margin: Margin;
  filter: CaseFilter;
  /** Eigener Kistenpreis je Typ (etwa der tatsächliche Einkaufspreis), sonst Marktpreis bei der Öffnung. */
  customPrice: Partial<Record<CaseCode, number>>;
}

const PREFS_KEY = 'wca:prefs';

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
    return {
      margin: { pct: num(p?.margin?.pct, DEFAULT_MARGIN.pct), abs: num(p?.margin?.abs, DEFAULT_MARGIN.abs) },
      filter: p?.filter === 'case1' || p?.filter === 'case2' ? p.filter : 'all',
      customPrice: Object.fromEntries(
        Object.entries(p?.customPrice ?? {}).filter(([c, v]) => (c === 'case1' || c === 'case2') && typeof v === 'number' && v > 0),
      ) as Prefs['customPrice'],
    };
  } catch {
    return { margin: { ...DEFAULT_MARGIN }, filter: 'all', customPrice: {} };
  }
}

export const prefs = signal<Prefs>(loadPrefs());

export function updatePrefs(patch: Partial<Prefs>): void {
  prefs.value = { ...prefs.value, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
  } catch {
    /* ignoriert */
  }
}

// ------------------------------------------------------------------ Märkte

export interface Quote {
  avg: number | null;
  bid: number | null;
  ask: number | null;
  avg7: number | null;
  volume7: number | null;
}

function quote(code: string): Quote {
  const m = market.value;
  const book = m.books[code];
  const { avg: avg7, volume } = recentAverage(m.history[code] ?? []);
  return {
    avg: m.prices[code] ?? null,
    bid: book?.buy[0]?.price ?? null,
    ask: book?.sell[0]?.price ?? null,
    avg7,
    volume7: volume,
  };
}

export const quotes = computed(() => ({ case1: quote('case1'), case2: quote('case2'), scraps: quote('scraps') }));

/** Schrott wird zum Durchschnittspreis gerechnet; der Geldkurs liegt meist nur einen Tick darunter. */
export const scrapPrice = computed(() => quotes.value.scraps.avg ?? quotes.value.scraps.bid ?? 0);

/** Bewertung je Itemcode über gleichverteilte Würfe (für den Erwartungswert einer Kiste). */
const codeValues = computed(() => {
  const price = scrapPrice.value;
  const margin = prefs.value.margin;
  const out: Record<string, CodeValue> = {};
  for (const [code, list] of Object.entries(sales.value)) {
    const rarity = rarityOf(code);
    if (rarity && list.length) out[code] = valueCode(rarity, list, statRangesOf(code), price, margin);
  }
  for (const [code, avg] of Object.entries(averages.value)) {
    const rarity = rarityOf(code);
    if (!rarity || out[code]) continue;
    const a = advise(rarity, avg, price, margin);
    out[code] = { policy: a.value, policySq: a.value * a.value, sale: avg, sellShare: a.action === 'sell' ? 1 : 0 };
  }
  return out;
});

export const caseValues = computed<Record<CaseCode, CaseValue>>(() => {
  const values = codeValues.value;
  const price = scrapPrice.value;
  return {
    case1: valueCase('case1', (code) => values[code] ?? null, price),
    case2: valueCase('case2', (code) => values[code] ?? null, price),
  };
});

export interface CaseMarket {
  code: CaseCode;
  quote: Quote;
  value: CaseValue;
  verdict: 'buy' | 'sell' | 'open';
  /** Erwartungswert minus Briefkurs (Gewinn je gekaufter und geöffneter Kiste). */
  edge: number | null;
}

export const caseMarkets = computed<CaseMarket[]>(() =>
  CASE_CODES.map((code) => {
    const q = quotes.value[code];
    const v = caseValues.value[code];
    return { code, quote: q, value: v, verdict: caseVerdict(v.ev, q.bid, q.ask), edge: q.ask === null ? null : v.ev - q.ask };
  }),
);

/** Schrott gegenüber dem Mittel der letzten sieben Tage. */
export const scrapTrend = computed(() => {
  const q = quotes.value.scraps;
  if (q.avg === null || q.avg7 === null) return null;
  const change = q.avg / q.avg7 - 1;
  return { change, verdict: change > 0.04 ? ('sell' as const) : change < -0.04 ? ('hold' as const) : ('neutral' as const) };
});

// ------------------------------------------------------------------ Ziehungen

export interface Row {
  pull: Pull;
  valuation: Valuation | null;
  advice: Advice;
  outcome: Outcome | null;
  /** Kistenpreis, mit dem diese Ziehung zählt. */
  cost: number | null;
  /** Was die Ziehung tatsächlich gebracht hat, sonst was die Empfehlung bringen würde. */
  value: number;
}

function valuationOf(p: Pull): Valuation | null {
  const list = sales.value[p.itemCode];
  if (list?.length) return estimateValue(p.skills, list, statRangesOf(p.itemCode));
  const avg = averages.value[p.itemCode];
  return avg ? { price: avg, basis: 'average', samples: 0 } : null;
}

export const allRows = computed<Row[]>(() => {
  const s = session.value;
  if (!s) return [];
  const price = scrapPrice.value;
  const margin = prefs.value.margin;
  const custom = prefs.value.customPrice;
  return s.pulls.map((pull) => {
    const valuation = valuationOf(pull);
    const advice = advise(pull.rarity ?? rarityOf(pull.itemCode), valuation?.price ?? null, price, margin);
    const outcome = s.outcomes[pull.id] ?? null;
    const value = outcome ? (outcome.kind === 'sold' ? outcome.amount : outcome.amount * price) : advice.value;
    return { pull, valuation, advice, outcome, cost: custom[pull.caseCode] ?? pull.cost, value };
  });
});

export const rows = computed(() => {
  const f = prefs.value.filter;
  return f === 'all' ? allRows.value : allRows.value.filter((r) => r.pull.caseCode === f);
});

export interface Totals {
  count: Record<CaseCode, number>;
  n: number;
  cost: number;
  /** Ziehungen ohne bekannten Kistenpreis. */
  costMissing: number;
  expected: number;
  scrapAll: number;
  saleAll: number;
  value: number;
  net: number;
  sellCount: number;
  scrapCount: number;
  scrapUnits: number;
  sold: number;
  scrapped: number;
}

export const totals = computed<Totals>(() => {
  const list = rows.value;
  const ev = caseValues.value;
  const count: Record<CaseCode, number> = { case1: 0, case2: 0 };
  let cost = 0;
  let costMissing = 0;
  let expected = 0;
  let scrapAll = 0;
  let saleAll = 0;
  let value = 0;
  let sellCount = 0;
  let scrapUnits = 0;
  let sold = 0;
  let scrapped = 0;
  for (const r of list) {
    count[r.pull.caseCode]++;
    if (r.cost === null) costMissing++;
    else cost += r.cost;
    expected += ev[r.pull.caseCode].ev;
    scrapAll += r.advice.scrapValue;
    saleAll += r.advice.sale ?? r.advice.scrapValue;
    value += r.value;
    if (r.advice.action === 'sell') sellCount++;
    else scrapUnits += r.advice.scrapUnits;
    if (r.outcome?.kind === 'sold') sold++;
    if (r.outcome?.kind === 'scrapped') scrapped++;
  }
  return {
    count,
    n: list.length,
    cost,
    costMissing,
    expected,
    scrapAll,
    saleAll,
    value,
    net: value - cost,
    sellCount,
    scrapCount: list.length - sellCount,
    scrapUnits,
    sold,
    scrapped,
  };
});

// Glück wird simuliert; bei schnellen Bursts nicht bei jeder einzelnen Öffnung neu
let luckCache: { key: string; value: number | null } = { key: '', value: null };
export const luck = computed(() => {
  const list = rows.value;
  const count = totals.value.count;
  const score = luckScore(list.map((r) => r.pull));
  const key = `${count.case1}|${count.case2}|${score}`;
  if (luckCache.key !== key) luckCache = { key, value: luckPercentile(count, score) };
  return { percentile: luckCache.value, score };
});

export const rarityTable = computed(() => rarityStats(rows.value.map((r) => r.pull)));

/** Serien: seit dem letzten guten Item und längste Durststrecke, je nach Kiste mit passender Schwelle. */
export const droughts = computed(() => {
  const list = rows.value.map((r) => r.pull);
  const mix = totals.value.count;
  // Rot: ab Episch, Grün: ab Selten; gemischt die Schwelle der überwiegenden Kiste
  const main: CaseCode = mix.case2 >= mix.case1 ? 'case2' : 'case1';
  const min: Rarity = main === 'case2' ? 'epic' : 'rare';
  const p = chanceAtLeast(main, min);
  return { min, since: sinceLast(list, min), longest: longestDrought(list, min), expectedGap: p > 0 ? 1 / p : null };
});

/** Kumulierte Bilanz und Erwartung je Ziehung, für den Verlauf. */
export const series = computed(() => {
  const list = rows.value;
  const ev = caseValues.value;
  const actual: number[] = [0];
  const expected: number[] = [0];
  const lo: number[] = [0];
  const hi: number[] = [0];
  let a = 0;
  let e = 0;
  let v = 0;
  for (const r of list) {
    const cost = r.cost ?? 0;
    a += r.value - cost;
    e += ev[r.pull.caseCode].ev - cost;
    v += ev[r.pull.caseCode].sd ** 2;
    actual.push(a);
    expected.push(e);
    lo.push(e - Math.sqrt(v));
    hi.push(e + Math.sqrt(v));
  }
  return { actual, expected, lo, hi };
});

/** Verkaufsliste: lohnende Items, die noch nicht weg sind, nach Mehrwert gegenüber dem Schrott. */
export const toSell = computed(() =>
  rows.value.filter((r) => r.advice.action === 'sell').sort((a, b) => b.advice.sale! - b.advice.scrapValue - (a.advice.sale! - a.advice.scrapValue)),
);

/** Schrottempfehlungen nach Seltenheit zusammengefasst. */
export const toScrap = computed(() => {
  const groups = new Map<string, { rarity: Rarity | null; count: number; units: number; done: number }>();
  for (const r of rows.value) {
    if (r.advice.action !== 'scrap') continue;
    const k = r.pull.rarity ?? 'unknown';
    const g = groups.get(k) ?? { rarity: r.pull.rarity, count: 0, units: 0, done: 0 };
    g.count++;
    g.units += r.advice.scrapUnits;
    if (r.outcome) g.done++;
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity));
});
