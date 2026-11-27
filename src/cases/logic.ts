// Reine Rechenlogik des Kisten-Assistenten, ohne DOM und Netz, damit sie sich testen lässt.
//
// Quellen der Zahlen (Stand 2026-11-27):
// - Seltenheiten der roten Kiste (case2): Artikel "Opening Cases: Is It Actually Worth It?" (warera.io, Mai 2026),
//   gegengeprüft an 4.000 Öffnungen aus der API (49,8 / 32,4 / 15,2 / 2,1 / 0,55 %).
// - Seltenheiten der grünen Kiste (case1): Artikel "War Era Math: Cases to Scraps" von Buffy_10 (warera.io, Juni 2026),
//   gegengeprüft an 4.000 Öffnungen aus der API (61,6 / 29,7 / 7,8 / 0,8 / 0,1 / 0 %).
// - 30 % Waffen: gameConfig.loot.weaponChancePercent; der Rest verteilt sich gleich auf fünf Ausrüstungsplätze.
// - Schrott beim Zerlegen: aus 1.500 dismantleItem-Transaktionen abgelesen, 6 · 3^Stufe bei vollem Zustand,
//   abgenutzte Stücke linear bis auf ein Drittel (abgerundet).

import { RARITIES, rarityRank, type Rarity, type RawTransaction, type Sale, type StatRanges, estimateValue } from '../battle/logic';

export type CaseCode = 'case1' | 'case2';
export const CASE_CODES: CaseCode[] = ['case2', 'case1'];

export function isCaseCode(value: unknown): value is CaseCode {
  return value === 'case1' || value === 'case2';
}

export const CASE_ODDS: Record<CaseCode, Record<Rarity, number>> = {
  case1: { common: 0.62, uncommon: 0.3, rare: 0.071, epic: 0.0085, legendary: 0.0004, mythic: 0.0001 },
  case2: { common: 0, uncommon: 0.5, rare: 0.32, epic: 0.15, legendary: 0.025, mythic: 0.005 },
};

export const WEAPON_SHARE = 0.3;
export const GEAR_SLOTS = ['helmet', 'chest', 'pants', 'boots', 'gloves'] as const;
export const WEAPON_BY_RARITY: Record<Rarity, string> = {
  common: 'knife',
  uncommon: 'gun',
  rare: 'rifle',
  epic: 'sniper',
  legendary: 'tank',
  mythic: 'jet',
};

/** Alle Itemcodes einer Seltenheit mit ihrer Wahrscheinlichkeit innerhalb dieser Seltenheit. */
export function codesOf(rarity: Rarity, weaponShare = WEAPON_SHARE): { code: string; p: number }[] {
  const tier = rarityRank(rarity) + 1;
  return [
    { code: WEAPON_BY_RARITY[rarity], p: weaponShare },
    ...GEAR_SLOTS.map((slot) => ({ code: `${slot}${tier}`, p: (1 - weaponShare) / GEAR_SLOTS.length })),
  ];
}

/** Itemcodes, die aus einer Kiste kommen können. */
export function caseCodes(caseCode: CaseCode): string[] {
  return RARITIES.filter((r) => CASE_ODDS[caseCode][r] > 0).flatMap((r) => codesOf(r).map((c) => c.code));
}

// ------------------------------------------------------------------ Schrott

/** Schrott bei vollem Zustand: 6, 18, 54, 162, 486, 1458. */
export function scrapBase(rarity: Rarity | null | undefined): number {
  const rank = rarityRank(rarity);
  return rank < 0 ? 0 : 6 * 3 ** rank;
}

/** Schrott beim Zerlegen; abgenutzte Stücke bringen linear weniger, bei Zustand 0 ein Drittel. */
export function scrapYield(rarity: Rarity | null | undefined, state = 100, maxState = 100): number {
  const base = scrapBase(rarity);
  const share = maxState > 0 ? Math.min(1, Math.max(0, state / maxState)) : 1;
  return Math.floor((base * (1 + 2 * share)) / 3 + 1e-9);
}

/** Erwarteter Schrott einer Kiste, wenn alles zerlegt wird. */
export function expectedScrap(caseCode: CaseCode): number {
  return RARITIES.reduce((sum, r) => sum + CASE_ODDS[caseCode][r] * scrapBase(r), 0);
}

// ------------------------------------------------------------------ Ziehungen

export interface Pull {
  /** Transaktions-ID der Öffnung. */
  id: string;
  /** ID des gezogenen Items (bleibt beim Zerlegen gleich, beim Verkauf bekommt der Käufer eine neue). */
  itemId: string;
  at: string;
  /**
   * Zeitpunkt, an dem der Spieler das Item bekam (lastAcquisitionAt, Millisekunden seit 1970). Ein Verkauf trägt
   * ihn unverändert und lässt sich damit genau der Ziehung zuordnen. Fehlt bei alten gespeicherten Sitzungen.
   */
  acq?: number;
  caseCode: CaseCode;
  itemCode: string;
  rarity: Rarity | null;
  skills: Record<string, number>;
  /**
   * Marktpreis der Kiste, als die Öffnung live erkannt wurde. Nachgeladene Ziehungen tragen null und werden
   * mit dem Tagesmittel ihres Tages bewertet (siehe priceOn).
   */
  cost: number | null;
}

export function toPull(
  tx: RawTransaction & { item?: (RawTransaction['item'] & { _id?: string; createdAt?: string; lastAcquisitionAt?: string }) | null },
  userId: string,
  rarityOf: (code: string) => Rarity | null,
): Omit<Pull, 'cost'> | null {
  if (!tx?._id || tx.transactionType !== 'openCase' || !tx.createdAt) return null;
  if (tx.buyerId !== userId && tx.sellerId !== userId) return null;
  if (!isCaseCode(tx.itemCode)) return null;
  const item = tx.item;
  if (!item?.code) return null;
  const acq = Date.parse(item.lastAcquisitionAt ?? '');
  return {
    id: tx._id,
    itemId: item._id ?? tx._id,
    at: tx.createdAt,
    ...(Number.isFinite(acq) ? { acq } : {}),
    caseCode: tx.itemCode,
    itemCode: item.code,
    rarity: rarityOf(item.code),
    skills: item.skills ?? {},
  };
}

export function byTime<T extends { at: string; id: string }>(a: T, b: T): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Führt zwei nach `cmp` sortierte Listen zu einer zusammen, ohne die große Liste neu zu sortieren. Beim Nachladen
 * liegen die neuen Ziehungen fast immer ganz vor oder ganz hinter den vorhandenen; dann genügt das Aneinanderhängen.
 * Gleiche Elemente behalten die Reihenfolge `a` vor `b`.
 */
export function mergeSorted<T>(a: readonly T[], b: readonly T[], cmp: (x: T, y: T) => number): T[] {
  if (!b.length) return a.slice();
  if (!a.length) return b.slice();
  if (cmp(a[a.length - 1], b[0]) <= 0) return [...a, ...b];
  if (cmp(b[b.length - 1], a[0]) < 0) return [...b, ...a];
  const out: T[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = cmp(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

// ------------------------------------------------------------------ Zeiträume

/** Ab wann gezählt wird: ab jetzt, rückwirkend ab einer festen Spanne, ab einem Datum oder alles, was es gibt. */
export type Since = 'now' | '1h' | '24h' | '7d' | '30d' | 'all' | 'date';

/** Auswahl als Schaltflächen; ein Datum wird über ein eigenes Feld gewählt. */
export const SINCE_OPTIONS: Exclude<Since, 'date'>[] = ['now', '1h', '24h', '7d', '30d', 'all'];

const HOUR = 3600_000;
const SPAN_MS: Partial<Record<Since, number>> = { '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };

/** Rückwirkende Zeiträume werden nachgeladen; „jetzt“ beobachtet nur, was danach geschieht. */
export const isRetro = (range: Since): boolean => range !== 'now';

/**
 * Untere Zeitgrenze (ISO) für einen rückwirkenden Zeitraum, null für „alles“ (und für „jetzt“, das keine hat).
 * Ein Datum (JJJJ-MM-TT) gilt ab Mitternacht Ortszeit; die Zukunft wird auf jetzt begrenzt.
 */
export function sinceFor(range: Since, now: number, date?: string | null): string | null {
  const span = SPAN_MS[range];
  if (span !== undefined) return new Date(now - span).toISOString();
  if (range === 'date') {
    const at = dayStart(date);
    return at === null ? null : new Date(Math.min(at, now)).toISOString();
  }
  return null;
}

/** Mitternacht (Ortszeit) eines Datums im Format JJJJ-MM-TT, null bei ungültiger Eingabe. */
export function dayStart(text: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(y, mo - 1, d);
  // 31.02. würde sonst still auf den 3.3. rutschen
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  return at.getTime();
}

// ------------------------------------------------------------------ Was später mit dem Item geschah

export interface Outcome {
  kind: 'scrapped' | 'sold';
  at: string;
  /** Erhaltener Schrott bzw. Verkaufserlös. */
  amount: number;
}

export interface DismantleTx {
  _id?: string;
  transactionType?: string;
  createdAt?: string;
  quantity?: number;
  buyerId?: string;
  item?: { _id?: string; code?: string } | null;
}

export interface MarketTx extends RawTransaction {
  offerCreatedAt?: string;
  item?: (RawTransaction['item'] & { _id?: string; lastAcquisitionAt?: string; createdAt?: string }) | null;
}

// Die Zuordnung steht in outcomes.ts (OutcomeMatcher, auch für Ströme in beliebiger Reihenfolge);
// matchOutcomes ordnet eine fertige Menge auf einen Schlag zu.
export { matchOutcomes, OutcomeMatcher, itemSignature } from './outcomes';

// ------------------------------------------------------------------ Empfehlung

export interface Margin {
  /** Mindestens so viel Prozent mehr als der Schrottwert. */
  pct: number;
  /** Und mindestens so viel mehr in Geld. */
  abs: number;
}

export const DEFAULT_MARGIN: Margin = { pct: 15, abs: 1 };

/** Ab diesem Verkaufspreis lohnt sich der Aufwand des Verkaufens gegenüber dem Zerlegen. */
export function sellThreshold(scrapValue: number, margin: Margin): number {
  return Math.max(scrapValue + Math.max(0, margin.abs), scrapValue * (1 + Math.max(0, margin.pct) / 100));
}

export interface Advice {
  action: 'sell' | 'scrap';
  scrapUnits: number;
  scrapValue: number;
  /** Geschätzter Verkaufswert, null ohne Marktdaten. */
  sale: number | null;
  /** Unter diesem Preis lieber zerlegen. */
  floor: number;
  /** Wert, den die Empfehlung bringt (Verkauf oder Schrott). */
  value: number;
}

export function advise(rarity: Rarity | null, sale: number | null | undefined, scrapPrice: number, margin: Margin): Advice {
  const scrapUnits = scrapYield(rarity);
  const scrapValue = scrapUnits * scrapPrice;
  const floor = sellThreshold(scrapValue, margin);
  const s = typeof sale === 'number' && sale > 0 ? sale : null;
  const sell = s !== null && s >= floor;
  return { action: sell ? 'sell' : 'scrap', scrapUnits, scrapValue, sale: s, floor, value: sell ? s! : scrapValue };
}

// ------------------------------------------------------------------ Erwartungswert einer Kiste

/** Gleichmäßig verteilte Würfe innerhalb der Spannen (bei zwei Werten ein Gitter). */
export function rollGrid(ranges: StatRanges | null | undefined, steps = 6): Record<string, number>[] {
  const keys = Object.keys(ranges ?? {});
  if (!keys.length) return [{}];
  const axis = (k: string) => {
    const [lo, hi] = ranges![k];
    const n = Math.min(steps, hi - lo + 1);
    return Array.from({ length: n }, (_, i) => Math.round(lo + ((hi - lo) * (i + 0.5)) / n));
  };
  let grid: Record<string, number>[] = [{}];
  for (const k of keys) grid = grid.flatMap((g) => axis(k).map((v) => ({ ...g, [k]: v })));
  return grid;
}

export interface CodeValue {
  /** Mittlerer Wert bei Verkauf nach Empfehlung (Verkauf oder Schrott, je Wurf). */
  policy: number;
  /** Mittleres Quadrat davon, für die Streuung. */
  policySq: number;
  /** Mittlerer Verkaufswert ohne Rücksicht auf Schrott, null ohne Verkäufe. */
  sale: number | null;
  /** Anteil der Würfe, die sich zu verkaufen lohnen. */
  sellShare: number;
}

/** Bewertet einen Itemcode über gleichverteilte Würfe, jeder aus den jüngsten Verkäufen geschätzt. */
export function valueCode(rarity: Rarity, sales: Sale[], ranges: StatRanges | null | undefined, scrapPrice: number, margin: Margin): CodeValue {
  const rolls = rollGrid(ranges);
  let policy = 0;
  let policySq = 0;
  let sale = 0;
  let sold = 0;
  let known = 0;
  for (const skills of rolls) {
    const est = sales.length ? estimateValue(skills, sales, ranges) : null;
    const a = advise(rarity, est?.price ?? null, scrapPrice, margin);
    policy += a.value;
    policySq += a.value * a.value;
    if (a.sale !== null) {
      sale += a.sale;
      known++;
    }
    if (a.action === 'sell') sold++;
  }
  const n = rolls.length;
  return { policy: policy / n, policySq: policySq / n, sale: known ? sale / known : null, sellShare: sold / n };
}

export interface CaseValue {
  /** Erwarteter Wert einer Kiste nach Empfehlung. */
  ev: number;
  /** Standardabweichung je Kiste. */
  sd: number;
  /** Erwarteter Wert, wenn alles zerlegt wird. */
  scrapEv: number;
  /** Anteil der Ziehungen, die man verkaufen sollte. */
  sellShare: number;
  /** Wie viele der möglichen Codes Marktdaten hatten. */
  coverage: number;
}

export function valueCase(caseCode: CaseCode, codeValue: (code: string, rarity: Rarity) => CodeValue | null, scrapPrice: number): CaseValue {
  let ev = 0;
  let sq = 0;
  let sell = 0;
  let codes = 0;
  let known = 0;
  for (const r of RARITIES) {
    const pr = CASE_ODDS[caseCode][r];
    if (!pr) continue;
    for (const { code, p } of codesOf(r)) {
      codes++;
      const v = codeValue(code, r);
      const fallback = scrapBase(r) * scrapPrice;
      if (v) known++;
      ev += pr * p * (v?.policy ?? fallback);
      sq += pr * p * (v?.policySq ?? fallback * fallback);
      sell += pr * p * (v?.sellShare ?? 0);
    }
  }
  return { ev, sd: Math.sqrt(Math.max(0, sq - ev * ev)), scrapEv: expectedScrap(caseCode) * scrapPrice, sellShare: sell, coverage: codes ? known / codes : 0 };
}

/** Kaufen, wenn der Erwartungswert über dem Briefkurs liegt; verkaufen, wenn ihn schon der Geldkurs übertrifft. */
export function caseVerdict(ev: number, bid: number | null, ask: number | null): 'buy' | 'sell' | 'open' {
  if (ask !== null && ev > ask) return 'buy';
  if (bid !== null && bid > ev) return 'sell';
  return 'open';
}

// ------------------------------------------------------------------ Glück

/** Kleiner, reproduzierbarer Zufallsgenerator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Schrott-Einheiten aller Ziehungen: unabhängig vom Markt und damit ein fairer Maßstab für Glück. */
export function luckScore(pulls: { rarity: Rarity | null }[]): number {
  return pulls.reduce((sum, p) => sum + scrapBase(p.rarity), 0);
}

/** Mittelwert, Varianz und drittes zentrales Moment der Schrott-Einheiten einer einzelnen Ziehung. */
export function drawMoments(caseCode: CaseCode): { mean: number; variance: number; third: number } {
  let mean = 0;
  let square = 0;
  for (const r of RARITIES) {
    const p = CASE_ODDS[caseCode][r];
    const units = scrapBase(r);
    mean += p * units;
    square += p * units * units;
  }
  let third = 0;
  for (const r of RARITIES) third += CASE_ODDS[caseCode][r] * (scrapBase(r) - mean) ** 3;
  return { mean, variance: square - mean * mean, third };
}

/** Verteilungsfunktion der Standardnormalverteilung (Zelen und Severo, Fehler unter 1e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = Math.exp((-x * x) / 2) * 0.3989422804014327 * poly;
  return x >= 0 ? 1 - upper : upper;
}

/**
 * Ab dieser Zahl Kisten rechnet luckPercentile mit der Normalnäherung statt zu simulieren: die Summe vieler
 * unabhängiger Ziehungen ist dann nahezu normalverteilt, und die Simulation würde bei 40.000 Kisten jedes
 * Mal über hundert Millisekunden brauchen.
 */
export const LUCK_SIMULATION_MAX = 8000;

/**
 * Glück über die Normalnäherung der Summe, Φ((Ist − Erwartung) / Streuung), mit der Schiefe-Korrektur erster
 * Ordnung (Edgeworth). Die Summe ist rechtsschief, weil seltene Items viel Schrott bringen; ohne Korrektur
 * läge der Median bei 48 statt 50 %.
 */
export function luckNormal(counts: Record<CaseCode, number>, score: number): number | null {
  const n = counts.case1 + counts.case2;
  if (!n) return null;
  let mean = 0;
  let variance = 0;
  let third = 0;
  for (const c of CASE_CODES) {
    const m = drawMoments(c);
    mean += counts[c] * m.mean;
    variance += counts[c] * m.variance;
    third += counts[c] * m.third;
  }
  if (!(variance > 0)) return score < mean ? 0 : score > mean ? 1 : 0.5;
  const sd = Math.sqrt(variance);
  const z = (score - mean) / sd;
  const skew = third / sd ** 3;
  const density = Math.exp((-z * z) / 2) * 0.3989422804014327;
  return Math.min(1, Math.max(0, normalCdf(z) - (skew / 6) * (z * z - 1) * density));
}

/**
 * Anteil gleich großer Sitzungen (gleiche Zahl roter und grüner Kisten), die weniger Schrott-Einheiten
 * gebracht hätten: 0,5 ist Durchschnitt, 0,95 heißt besser als 95 %. Gleichstände zählen zur Hälfte.
 * Bis LUCK_SIMULATION_MAX Kisten wird simuliert, darüber genügt die Normalnäherung.
 */
export function luckPercentile(counts: Record<CaseCode, number>, score: number, sims?: number, seed = 7): number | null {
  const n = counts.case1 + counts.case2;
  if (!n) return null;
  if (sims === undefined && n > LUCK_SIMULATION_MAX) return luckNormal(counts, score);
  const runs = sims ?? Math.max(300, Math.min(4000, Math.floor(3_000_000 / n)));
  const tables = CASE_CODES.map((c) => {
    const cum: [number, number][] = [];
    let acc = 0;
    for (const r of RARITIES) {
      if (!CASE_ODDS[c][r]) continue;
      acc += CASE_ODDS[c][r];
      cum.push([acc, scrapBase(r)]);
    }
    return { n: counts[c], cum };
  });
  const rand = rng(seed + n * 31 + counts.case1);
  let below = 0;
  let equal = 0;
  for (let s = 0; s < runs; s++) {
    let total = 0;
    for (const { n: k, cum } of tables) {
      for (let i = 0; i < k; i++) {
        const x = rand();
        let j = 0;
        while (j < cum.length - 1 && x >= cum[j][0]) j++;
        total += cum[j][1];
      }
    }
    if (total < score) below++;
    else if (total === score) equal++;
  }
  return (below + equal / 2) / runs;
}

/** Wahrscheinlichkeit, mindestens bzw. höchstens k Treffer bei n Versuchen mit Chance p zu sehen. */
export function binomialTail(n: number, k: number, p: number, side: 'atLeast' | 'atMost'): number {
  if (p <= 0) return side === 'atLeast' ? (k <= 0 ? 1 : 0) : 1;
  if (p >= 1) return side === 'atLeast' ? 1 : k >= n ? 1 : 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  // log(n über i) iterativ
  let logC = 0;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    const inRange = side === 'atLeast' ? i >= k : i <= k;
    if (inRange) sum += Math.exp(logC + i * lp + (n - i) * lq);
    if (side === 'atMost' && i >= k) break;
  }
  return Math.min(1, Math.max(0, sum));
}

export interface RarityStat {
  rarity: Rarity;
  count: number;
  expected: number;
  /** Wie wahrscheinlich ein so deutliches Ergebnis in diese Richtung ist (einseitig). */
  chance: number;
}

export function rarityStats(pulls: { caseCode: CaseCode; rarity: Rarity | null }[]): RarityStat[] {
  const counts: Record<CaseCode, number> = { case1: 0, case2: 0 };
  for (const p of pulls) counts[p.caseCode]++;
  const n = pulls.length;
  return RARITIES.map((rarity) => {
    const count = pulls.filter((p) => p.rarity === rarity).length;
    const expected = CASE_CODES.reduce((s, c) => s + counts[c] * CASE_ODDS[c][rarity], 0);
    // gemischte Sitzungen: mittlere Chance als Näherung
    const p = n ? expected / n : 0;
    const chance = count >= expected ? binomialTail(n, count, p, 'atLeast') : binomialTail(n, count, p, 'atMost');
    return { rarity, count, expected, chance };
  }).filter((s) => s.expected > 0 || s.count > 0);
}

/** Ziehungen seit dem letzten Item ab dieser Seltenheit (null: noch keins in der Sitzung). */
export function sinceLast(pulls: { rarity: Rarity | null }[], minRarity: Rarity): number {
  const min = rarityRank(minRarity);
  for (let i = pulls.length - 1; i >= 0; i--) if (rarityRank(pulls[i].rarity) >= min) return pulls.length - 1 - i;
  return pulls.length;
}

/** Längste Serie ohne Item ab dieser Seltenheit. */
export function longestDrought(pulls: { rarity: Rarity | null }[], minRarity: Rarity): number {
  const min = rarityRank(minRarity);
  let best = 0;
  let run = 0;
  for (const p of pulls) {
    if (rarityRank(p.rarity) >= min) run = 0;
    else best = Math.max(best, ++run);
  }
  return best;
}

/** Chance einer Ziehung, mindestens diese Seltenheit zu bringen. */
export function chanceAtLeast(caseCode: CaseCode, minRarity: Rarity): number {
  const min = rarityRank(minRarity);
  return RARITIES.filter((r) => rarityRank(r) >= min).reduce((s, r) => s + CASE_ODDS[caseCode][r], 0);
}

// ------------------------------------------------------------------ Kurse

/** Tagesmittel einer Ware, zum schnellen Nachschlagen aufbereitet (Tage aufsteigend als JJJJ-MM-TT). */
export interface PriceIndex {
  days: string[];
  prices: number[];
}

/** Baut den Index aus itemTrading.getItemTrading; Tage ohne Handel (kein Mittel) fehlen einfach. */
export function priceIndex(values: { valueAt?: string; avgValue?: number }[] | undefined | null): PriceIndex {
  const rows = (values ?? [])
    .filter((v): v is { valueAt: string; avgValue: number } => typeof v.valueAt === 'string' && typeof v.avgValue === 'number' && v.avgValue > 0)
    .map((v) => ({ day: v.valueAt.slice(0, 10), price: v.avgValue }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { days: rows.map((r) => r.day), prices: rows.map((r) => r.price) };
}

/**
 * Tagesmittel am Tag von `iso` (UTC-Tag wie in der API). Tage ohne Handel nehmen den letzten Tag davor; liegt der Zeitpunkt
 * vor dem Verlauf (die API liefert 30 Tage), gilt der älteste Tag. Null, wenn es gar keinen Verlauf gibt.
 */
export function priceOn(index: PriceIndex, iso: string): number | null {
  const n = index.days.length;
  if (!n) return null;
  const day = iso.slice(0, 10);
  let lo = 0;
  let hi = n - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.days[mid] <= day) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return index.prices[at < 0 ? 0 : at];
}

/** Mittel der letzten vollständigen Tage aus itemTrading.getItemTrading (älteste zuerst, letzter Tag läuft noch). */
export function recentAverage(values: { avgValue?: number; totalQuantity?: number }[], days = 7): { avg: number | null; volume: number | null } {
  const done = values
    .slice(0, -1)
    .slice(-days)
    .filter((v) => typeof v.avgValue === 'number' && (v.totalQuantity ?? 0) > 0);
  if (!done.length) return { avg: null, volume: null };
  const qty = done.reduce((s, v) => s + (v.totalQuantity ?? 0), 0);
  const money = done.reduce((s, v) => s + (v.avgValue ?? 0) * (v.totalQuantity ?? 0), 0);
  return { avg: qty ? money / qty : null, volume: qty / done.length };
}
