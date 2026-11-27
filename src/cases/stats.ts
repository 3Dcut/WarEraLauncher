// Abgeleitete Werte des Kisten-Assistenten: Bewertung je Kombination, Summen, Erwartung, Glück, Verlauf und Marktlage. Alles als
// computed, damit die Oberfläche nur abbildet. Die Auswertung über alle Ziehungen läuft in einem Durchlauf (aggregate.ts) über
// den Spaltenspeicher; Zeilenobjekte entstehen nur für die wenigen Einträge, die gerade zu sehen sind.

import { signal, computed } from '@preact/signals';
import { estimateValue, RARITIES, type Valuation, type Sale } from '../battle/logic';
import { rarityOf, statRangesOf } from '../battle/api';
import type { TradingDay } from '../assist/api';
import { averages, market, sales, storeVersion, getStore } from './engine';
import { aggregate, type AggParams, type Aggregates, type ComboTable, type Series } from './aggregate';
import { KIND_OPEN, KIND_SOLD, dayIndex, dayStartMs, type PullStore } from './store';
import {
  advise,
  caseVerdict,
  CASE_CODES,
  chanceAtLeast,
  DEFAULT_MARGIN,
  luckPercentile,
  priceIndex,
  priceOn,
  rarityStatsFromCounts,
  recentAverage,
  scrapYield,
  sellThreshold,
  valueCase,
  valueCode,
  type Advice,
  type CaseCode,
  type CaseValue,
  type CodeValue,
  type Margin,
  type Outcome,
  type PriceIndex,
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

// ------------------------------------------------------------------ Tagespreise

interface DayPrices {
  case1: PriceIndex;
  case2: PriceIndex;
  scraps: PriceIndex;
}

let lastHistory: Record<string, TradingDay[]> | null = null;
let lastDays: DayPrices = { case1: priceIndex([]), case2: priceIndex([]), scraps: priceIndex([]) };

/**
 * Tagesmittel der letzten 30 Tage für Kisten und Schrott. Die Identität bleibt gleich, solange sich der Verlauf nicht
 * ändert; die Zwischenspeicher unten verlassen sich darauf.
 */
export const dayPrices = computed<DayPrices>(() => {
  const history = market.value.history;
  if (history !== lastHistory) {
    lastHistory = history;
    lastDays = { case1: priceIndex(history.case1), case2: priceIndex(history.case2), scraps: priceIndex(history.scraps) };
  }
  return lastDays;
});

interface DayArrays {
  key: unknown[];
  minDay: number;
  cost: [Float32Array, Float32Array];
  scrap: Float32Array;
}
let dayCache: DayArrays | null = null;

/** Tagesmittel als Felder ab dem ersten Tag der Ziehungen bis heute, damit der Durchlauf sie je Ziehung nur nachschlägt. */
function dayArrays(store: PullStore, days: DayPrices): DayArrays {
  const span = store.span();
  const minDay = span ? dayIndex(span.first) : 0;
  const maxDay = Math.max(minDay, dayIndex(Date.now()));
  const key = [days, minDay, maxDay];
  if (dayCache && dayCache.key.every((k, i) => k === key[i])) return dayCache;
  const n = Math.min(maxDay - minDay + 1, 40_000);
  const cost: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  const scrap = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const iso = new Date(dayStartMs(minDay + i)).toISOString();
    cost[0][i] = priceOn(days.case1, iso) ?? NaN;
    cost[1][i] = priceOn(days.case2, iso) ?? NaN;
    scrap[i] = priceOn(days.scraps, iso) ?? NaN;
  }
  return (dayCache = { key, minDay, cost, scrap });
}

// ------------------------------------------------------------------ Bewertung je Kombination

/** Schätzung eines Items aus den jüngsten Verkäufen seines Codes, sonst aus dem Durchschnittspreis. */
function estimate(code: string, skills: Record<string, number>, soldBy: Record<string, Sale[]>, avgBy: Record<string, number>): Valuation | null {
  const list = soldBy[code];
  if (list?.length) return estimateValue(skills, list, statRangesOf(code));
  const avg = avgBy[code];
  return avg ? { price: avg, basis: 'average', samples: 0 } : null;
}

interface ComboCache {
  store: PullStore;
  deps: unknown[];
  stamp: string;
  n: number;
  cap: number;
  table: ComboTable;
}
let comboCache: ComboCache | null = null;

const newTable = (cap: number): ComboTable => ({
  rank: new Int8Array(cap),
  sale: new Float32Array(cap),
  scrapValue: new Float32Array(cap),
  value: new Float32Array(cap),
  sell: new Uint8Array(cap),
});

/**
 * Bewertung und Empfehlung je Kombination aus Code und Werten. Aus der Kiste fallen nur einige tausend verschiedene; die
 * Bewertung gilt deshalb für alle Ziehungen mit derselben Kombination. Neu hinzugekommene Kombinationen werden einzeln
 * nachgerechnet, alles andere nur bei geänderten Verkäufen, Schrottpreisen, Spannen oder Seltenheiten.
 */
function comboTableFor(store: PullStore): ComboTable {
  const dict = store.dict;
  const soldBy = sales.value;
  const avgBy = averages.value;
  const price = scrapPrice.value;
  const margin = prefs.value.margin;
  const stamp = dict.codes.map((c) => rarityOf(c) ?? '-').join(',');
  const deps = [soldBy, avgBy, price, margin];
  let cc = comboCache;
  const same = !!cc && cc.store === store && cc.stamp === stamp && cc.deps.every((d, i) => d === deps[i]);
  if (!cc || !same) {
    const cap = Math.max(1024, 1 << Math.ceil(Math.log2(Math.max(1, dict.comboCount * 1.5))));
    cc = comboCache = { store, deps, stamp, n: 0, cap, table: newTable(cap) };
  } else if (dict.comboCount > cc.cap) {
    const cap = cc.cap * 2 > dict.comboCount ? cc.cap * 2 : dict.comboCount * 2;
    const next = newTable(cap);
    next.rank.set(cc.table.rank);
    next.sale.set(cc.table.sale);
    next.scrapValue.set(cc.table.scrapValue);
    next.value.set(cc.table.value);
    next.sell.set(cc.table.sell);
    cc.table = next;
    cc.cap = cap;
  }
  const t = cc.table;
  for (let c = cc.n; c < dict.comboCount; c++) {
    const code = dict.codes[dict.comboCode[c]];
    const rarity = rarityOf(code);
    const a = advise(rarity, estimate(code, dict.skillsOf(c), soldBy, avgBy)?.price ?? null, price, margin);
    t.rank[c] = rarity ? RARITIES.indexOf(rarity) : -1;
    t.sale[c] = a.sale ?? NaN;
    t.scrapValue[c] = a.scrapValue;
    t.value[c] = a.value;
    t.sell[c] = a.action === 'sell' ? 1 : 0;
  }
  cc.n = dict.comboCount;
  return t;
}

// ------------------------------------------------------------------ Auswertung

/** Anzahl Fächer des Verlaufs: mehr Punkte als die Breite einer Grafik hergibt, aber jede Kiste fließt ein. */
export const SERIES_BUCKETS = 1200;
const UNITS = RARITIES.map((r) => scrapYield(r));

/** Alles über sämtliche Ziehungen in einem Durchlauf; rechnet bei jedem Veröffentlichen und bei geänderten Preisen neu. */
export const aggregates = computed<Aggregates>(() => {
  void storeVersion.value;
  const store = getStore();
  const combos = comboTableFor(store);
  const p = prefs.value;
  const ev = caseValues.value;
  const d = dayArrays(store, dayPrices.value);
  const current = market.value.prices;
  const params: AggParams = {
    filter: p.filter === 'all' ? -1 : p.filter === 'case1' ? 0 : 1,
    custom: [p.customPrice.case1 ?? null, p.customPrice.case2 ?? null],
    current: [current.case1 ?? NaN, current.case2 ?? NaN],
    scrapNow: scrapPrice.value,
    ev: [ev.case1.ev, ev.case2.ev],
    sd: [ev.case1.sd, ev.case2.sd],
    buckets: SERIES_BUCKETS,
    minDay: d.minDay,
    costByDay: d.cost,
    scrapByDay: d.scrap,
    unitsByRank: UNITS,
    combos,
  };
  return aggregate(store, params);
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
  const a = aggregates.value;
  return {
    count: { case1: a.count[0], case2: a.count[1] },
    n: a.n,
    cost: a.cost,
    costMissing: a.costMissing,
    expected: a.expected,
    scrapAll: a.scrapAll,
    saleAll: a.saleAll,
    value: a.value,
    net: a.value - a.cost,
    sellCount: a.sellCount,
    scrapCount: a.scrapCount,
    scrapUnits: a.scrapUnits,
    sold: a.sold,
    scrapped: a.scrapped,
  };
});

// Glück wird berechnet (ab 8.000 Kisten genähert); bei schnellen Seiten nicht bei jeder einzelnen neu
let luckCache: { key: string; value: number | null } = { key: '', value: null };
export const luck = computed(() => {
  const a = aggregates.value;
  const count = { case1: a.count[0], case2: a.count[1] };
  const key = `${count.case1}|${count.case2}|${a.luckScore}`;
  if (luckCache.key !== key) luckCache = { key, value: luckPercentile(count, a.luckScore) };
  return { percentile: luckCache.value, score: a.luckScore };
});

export const rarityTable = computed(() => {
  const a = aggregates.value;
  return rarityStatsFromCounts({ case1: a.count[0], case2: a.count[1] }, a.rarity);
});

/** Serien: seit dem letzten guten Item und längste Durststrecke, je nach Kiste mit passender Schwelle. */
export const droughts = computed(() => {
  const a = aggregates.value;
  // Rot: ab Episch, Grün: ab Selten; gemischt die Schwelle der überwiegenden Kiste
  const main: CaseCode = a.count[1] >= a.count[0] ? 'case2' : 'case1';
  const min = main === 'case2' ? ('epic' as const) : ('rare' as const);
  const d = main === 'case2' ? a.epic : a.rare;
  const p = chanceAtLeast(main, min);
  return { min, since: d.since, longest: d.longest, expectedGap: p > 0 ? 1 / p : null };
});

/** Verlauf in Fächern: Endwerte, Streuungsband und Min/Max des Ergebnisses je Fach. */
export const series = computed<Series>(() => aggregates.value.series);

/** Je Ziehung in zeitlicher Reihenfolge: Seltenheit + 1 (0 unbekannt), für das Zellband. */
export const strip = computed(() => aggregates.value.strip);

/** Verkaufsliste: Slots lohnender Items nach Mehrwert gegenüber dem Schrott, dazu wie viele davon noch offen sind. */
export const toSell = computed(() => {
  const a = aggregates.value;
  const store = getStore();
  const t = comboTableFor(store);
  const slots = Uint32Array.from(a.sellSlots);
  const gain = (slot: number) => t.sale[store.combo[slot]] - t.scrapValue[store.combo[slot]];
  slots.sort((x, y) => gain(y) - gain(x));
  let open = 0;
  for (let i = 0; i < slots.length; i++) if (store.kind[slots[i]] === KIND_OPEN) open++;
  return { slots, open };
});

/** Schrottempfehlungen nach Seltenheit zusammengefasst. */
export const toScrap = computed(() => {
  const g = aggregates.value.scrapGroups;
  const out: { rarity: (typeof RARITIES)[number] | null; count: number; units: number; done: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    if (!g.count[i]) continue;
    out.push({ rarity: i === 0 ? null : RARITIES[i - 1], count: g.count[i], units: g.units[i], done: g.done[i] });
  }
  return out;
});

// ------------------------------------------------------------------ Zeilen für Listen und Hinweise

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

/** Baut die Zeile zu einem Slot des Speichers: nur für das, was gerade zu sehen ist. */
export function rowAt(slot: number): Row {
  const store = getStore();
  const t = comboTableFor(store);
  const p = prefs.value;
  const dict = store.dict;
  const c = store.combo[slot];
  const code = dict.codes[dict.comboCode[c]];
  const rank = t.rank[c];
  const rarity = rank >= 0 ? RARITIES[rank] : null;
  const skills = dict.skillsOf(c);
  const caseCode: CaseCode = store.kase[slot] === 1 ? 'case2' : 'case1';
  const sale = Number.isNaN(t.sale[c]) ? null : t.sale[c];
  const advice: Advice = {
    action: t.sell[c] ? 'sell' : 'scrap',
    scrapUnits: rank >= 0 ? scrapYield(rarity) : 0,
    scrapValue: t.scrapValue[c],
    sale,
    floor: sellThreshold(t.scrapValue[c], p.margin),
    value: t.value[c],
  };
  const days = dayPrices.value;
  const kind = store.kind[slot];
  let value = advice.value;
  let outcome: Outcome | null = null;
  if (kind !== KIND_OPEN) {
    const at = new Date(dayStartMs(store.oday[slot])).toISOString();
    outcome = { kind: kind === KIND_SOLD ? 'sold' : 'scrapped', at, amount: store.amount[slot] };
    value = kind === KIND_SOLD ? outcome.amount : outcome.amount * (priceOn(days.scraps, at) ?? scrapPrice.value);
  }
  let cost: number | null = p.customPrice[caseCode] ?? null;
  if (cost === null) {
    const own = store.cost[slot];
    cost = Number.isNaN(own) ? (priceOn(days[caseCode], new Date(store.at[slot]).toISOString()) ?? market.value.prices[caseCode] ?? null) : own;
  }
  const pull: Pull = { id: String(slot), at: new Date(store.at[slot]).toISOString(), caseCode, itemCode: code, rarity, skills, cost };
  return { pull, valuation: estimate(code, skills, sales.value, averages.value), advice, outcome, cost, value };
}

/** Slot der Ziehung an Stelle `pos` des Zellbands (zeitliche Reihenfolge unter dem gewählten Filter), -1 wenn es sie nicht gibt. */
export function stripSlot(pos: number): number {
  const store = getStore();
  const f = prefs.value.filter;
  if (f === 'all') return pos >= 0 && pos < store.published ? store.order[pos] : -1;
  const want = f === 'case1' ? 0 : 1;
  let k = -1;
  for (let i = 0; i < store.published; i++) {
    const slot = store.order[i];
    if (store.kase[slot] === want && ++k === pos) return slot;
  }
  return -1;
}
