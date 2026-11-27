// Reine Spiellogik des Kisten-Battles, ohne DOM und Netz, damit sie sich testen lässt.
//
// Regeln: Zwei Spieler öffnen abwechselnd Kisten. Die n-te Öffnung von A tritt gegen die
// n-te Öffnung von B an; die seltenere Item-Kategorie (Seltenheit) gewinnt die Runde und
// bringt einen Punkt, gleiche Seltenheit ist ein Gleichstand ohne Punkt. Wer zuerst das
// Punkteziel erreicht, gewinnt; spätere Öffnungen zählen nicht mehr.

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type Rarity = (typeof RARITIES)[number];
export type Side = 0 | 1;

export function isRarity(value: unknown): value is Rarity {
  return typeof value === 'string' && (RARITIES as readonly string[]).includes(value);
}

/** 0 (gewöhnlich) bis 5 (mythisch), -1 für unbekannte Items. */
export function rarityRank(rarity: Rarity | null | undefined): number {
  return rarity ? RARITIES.indexOf(rarity) : -1;
}

// ------------------------------------------------------------------ Kisten

export interface CaseType {
  code: 'case2' | 'case1';
  /** Schlüssel für Texte (battle.case.<key>). */
  key: 'red' | 'green';
}

/** Offiziell nur rote Kisten (Elite, case2); grün (case1) als Ausweichmöglichkeit. */
export const CASE_TYPES: CaseType[] = [
  { code: 'case2', key: 'red' },
  { code: 'case1', key: 'green' },
];

/** Rot, wenn nichts oder etwas Unbekanntes angegeben ist. */
export function caseType(code: string | null | undefined): CaseType {
  return CASE_TYPES.find((c) => c.code === code) ?? CASE_TYPES[0];
}

/** Liest "rot"/"red"/"case2" bzw. "gruen"/"grün"/"green"/"case1" aus einem Link. */
export function caseFromParam(value: string | null | undefined): CaseType['code'] | null {
  const v = (value ?? '').trim().toLowerCase();
  if (['rot', 'red', 'röd', 'case2', 'elite'].includes(v)) return 'case2';
  if (['gruen', 'grün', 'green', 'grön', 'case1'].includes(v)) return 'case1';
  return null;
}

/** Offizielles Format: wer zuerst drei Runden gewinnt (FT3). */
export const TARGET = 3;

// ------------------------------------------------------------------ Items

const EQUIPMENT_EMOJI: Record<string, string> = {
  helmet: '🪖',
  chest: '🦺',
  pants: '👖',
  boots: '🥾',
  gloves: '🧤',
  sickle: '🌾',
  pickaxe: '⛏️',
  skillet: '🍳',
  hammer: '🔨',
  flask: '⚗️',
  caliper: '📏',
};

const WEAPONS: Record<string, { emoji: string; rarity: Rarity }> = {
  knife: { emoji: '🔪', rarity: 'common' },
  gun: { emoji: '🔫', rarity: 'uncommon' },
  rifle: { emoji: '🎯', rarity: 'rare' },
  sniper: { emoji: '🔭', rarity: 'epic' },
  tank: { emoji: '💥', rarity: 'legendary' },
  jet: { emoji: '✈️', rarity: 'mythic' },
};

/** Grundtypen aller Items, die aus Kisten kommen können (für Namen: battle.item.<base>). */
export const ITEM_BASES = [...Object.keys(EQUIPMENT_EMOJI), ...Object.keys(WEAPONS)];

/** Bekannte Werte auf Items (für Namen: battle.skill.<name>). */
export const SKILLS = ['attack', 'criticalChance', 'criticalDamages', 'armor', 'precision', 'dodge', 'production'];

export interface ItemInfo {
  /** Grundtyp ohne Stufe (helmet3 → helmet), null bei unbekannten Items. */
  base: string | null;
  emoji: string;
}

export function itemInfo(code: string): ItemInfo {
  const weapon = WEAPONS[code];
  if (weapon) return { base: code, emoji: weapon.emoji };
  const m = /^([a-z]+?)(\d)$/i.exec(code);
  if (m && EQUIPMENT_EMOJI[m[1]]) return { base: m[1], emoji: EQUIPMENT_EMOJI[m[1]] };
  return { base: null, emoji: '📦' };
}

/**
 * Seltenheit ohne Spielkonfiguration: Ausrüstung und Werkzeuge tragen die Stufe als Ziffer
 * (helmet1 = gewöhnlich … helmet6 = mythisch), Waffen haben feste Stufen.
 */
export function fallbackRarity(code: string): Rarity | null {
  const weapon = WEAPONS[code];
  if (weapon) return weapon.rarity;
  const m = /^([a-z]+?)(\d)$/i.exec(code);
  if (m && EQUIPMENT_EMOJI[m[1]]) {
    const tier = Number(m[2]);
    if (tier >= 1 && tier <= 6) return RARITIES[tier - 1];
  }
  return null;
}

// ------------------------------------------------------------------ Öffnungen

export interface Opening {
  /** Transaktions-ID aus der API (bzw. eine erfundene im Demo-Modus). */
  id: string;
  /** Zeitpunkt laut Server (ISO). */
  at: string;
  caseCode: string;
  itemCode: string;
  rarity: Rarity | null;
  skills?: Record<string, number>;
}

/** Ausschnitt einer Transaktion (openCase oder itemMarket), wie sie transaction.getPaginatedTransactions liefert. */
export interface RawTransaction {
  _id?: string;
  transactionType?: string;
  itemCode?: string;
  buyerId?: string;
  sellerId?: string;
  createdAt?: string;
  /** Bei itemMarket: gezahlter Preis für die ganze Menge. */
  money?: number;
  quantity?: number;
  /** Bei itemMarket: Durchschnittspreis des Itemcodes zum Zeitpunkt des Verkaufs. */
  marketAvgPrice?: number;
  item?: { code?: string; skills?: Record<string, number>; state?: number; maxState?: number } | null;
}

export function toOpening(tx: RawTransaction, userId: string, rarityOf: (code: string) => Rarity | null): Opening | null {
  if (!tx?._id || tx.transactionType !== 'openCase') return null;
  if (tx.buyerId !== userId && tx.sellerId !== userId) return null;
  const itemCode = tx.item?.code;
  if (!itemCode || !tx.createdAt) return null;
  return {
    id: tx._id,
    at: tx.createdAt,
    caseCode: tx.itemCode ?? '',
    itemCode,
    rarity: rarityOf(itemCode),
    skills: tx.item?.skills ?? undefined,
  };
}

export function byTime(a: Opening, b: Opening): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Stand vor dem Start: Alles, was es da schon gab, zählt nicht. Gemerkt werden die IDs und
 * die jüngste Serverzeit, damit eine abweichende Uhr im Browser keine Rolle spielt.
 */
export interface Baseline {
  since: string | null;
  seen: string[];
}

export function makeBaseline(existing: Opening[]): Baseline {
  const sorted = [...existing].sort(byTime);
  return { since: sorted.length ? sorted[sorted.length - 1].at : null, seen: sorted.map((o) => o.id) };
}

/** Neue Öffnungen aus einer Abfrage, chronologisch, ohne bekannte und ohne solche aus der Zeit vor dem Start. */
export function freshOpenings(incoming: Opening[], baseline: Baseline, known: Opening[]): Opening[] {
  const skip = new Set([...baseline.seen, ...known.map((o) => o.id)]);
  const out: Opening[] = [];
  for (const o of incoming) {
    if (skip.has(o.id)) continue;
    if (baseline.since && o.at < baseline.since) continue;
    skip.add(o.id);
    out.push(o);
  }
  return out.sort(byTime);
}

// ------------------------------------------------------------------ Wertung

export interface Round {
  index: number;
  a: Opening;
  b: Opening;
  winner: Side | null;
}

export interface Standing {
  rounds: Round[];
  points: [number, number];
  winner: Side | null;
  /** Wer als Nächstes öffnen sollte (A beginnt jede Runde). */
  turn: Side;
  /** Öffnungen ohne Gegenpart in der laufenden Runde. */
  waiting: [Opening[], Opening[]];
}

export function duel(a: Opening, b: Opening): Side | null {
  const ra = rarityRank(a.rarity);
  const rb = rarityRank(b.rarity);
  if (ra === rb) return null;
  return ra > rb ? 0 : 1;
}

export function evaluate(openingsA: Opening[], openingsB: Opening[], target: number): Standing {
  const a = [...openingsA].sort(byTime);
  const b = [...openingsB].sort(byTime);
  const rounds: Round[] = [];
  const points: [number, number] = [0, 0];
  let winner: Side | null = null;
  const pairs = Math.min(a.length, b.length);
  let i = 0;
  for (; i < pairs && winner === null; i++) {
    const w = duel(a[i], b[i]);
    rounds.push({ index: i + 1, a: a[i], b: b[i], winner: w });
    if (w !== null) {
      points[w]++;
      if (points[w] >= target) winner = w;
    }
  }
  const waiting: [Opening[], Opening[]] = winner === null ? [a.slice(i), b.slice(i)] : [[], []];
  const turn: Side = waiting[0].length > waiting[1].length ? 1 : 0;
  return { rounds, points, winner, turn, waiting };
}

// ------------------------------------------------------------------ Bilanz

/**
 * Ausrüstung wird nicht zu einem Marktpreis gehandelt, sondern Stück für Stück, und der Preis
 * hängt am gewürfelten Wert (boots5 mit Ausweichen 31 um 160, mit 40 um 220). Geschätzt wird
 * deshalb aus den jüngsten Verkäufen desselben Itemcodes: der Median der drei Verkäufe, deren
 * Werte am nächsten liegen. Identische Würfe liegen dabei vorn, unter Gleichen der jüngste.
 * Abstände werden auf die Spanne des Werts laut Spielkonfiguration bezogen, damit bei Waffen
 * Angriff (221–300) und Krit-Chance (41–50) gleich schwer wiegen.
 */
export interface Sale {
  id: string;
  at: string;
  price: number;
  skills: Record<string, number>;
  /** Durchschnittspreis des Codes laut Server zum Zeitpunkt des Verkaufs. */
  avg?: number;
}

/** Spanne je Wert, etwa { dodge: [31, 40] } (gameConfig.items[code].dynamicStats). */
export type StatRanges = Record<string, [number, number]>;

export interface Valuation {
  price: number;
  /** identical: nur gleiche Würfe, similar: nächste Würfe, average: Durchschnitt des Codes. */
  basis: 'identical' | 'similar' | 'average';
  samples: number;
}

/** Wie viele Verkäufe in eine Schätzung eingehen. */
export const VALUE_SAMPLES = 3;

export function toSale(tx: RawTransaction): Sale | null {
  if (!tx?._id || tx.transactionType !== 'itemMarket' || !tx.createdAt) return null;
  const quantity = tx.quantity && tx.quantity > 0 ? tx.quantity : 1;
  const price = typeof tx.money === 'number' ? tx.money / quantity : NaN;
  if (!Number.isFinite(price) || price <= 0) return null;
  // Abgenutzte Stücke sind billiger; aus Kisten kommt alles neu
  const item = tx.item;
  if (item && typeof item.state === 'number' && typeof item.maxState === 'number' && item.state < item.maxState) return null;
  return {
    id: tx._id,
    at: tx.createdAt,
    price,
    skills: item?.skills ?? {},
    avg: typeof tx.marketAvgPrice === 'number' && tx.marketAvgPrice > 0 ? tx.marketAvgPrice : undefined,
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Spannen aus der Spielkonfiguration, ersatzweise aus den Verkäufen selbst. */
function rangesFor(skills: Record<string, number>, sales: Sale[], ranges: StatRanges | null | undefined): StatRanges {
  const out: StatRanges = {};
  const keys = new Set([...Object.keys(ranges ?? {}), ...Object.keys(skills)]);
  for (const k of keys) {
    const r = ranges?.[k];
    if (r) {
      out[k] = r;
      continue;
    }
    const seen = sales.map((s) => s.skills[k]).filter((v): v is number => typeof v === 'number');
    if (typeof skills[k] === 'number') seen.push(skills[k]);
    out[k] = seen.length ? [Math.min(...seen), Math.max(...seen)] : [0, 1];
  }
  return out;
}

export function estimateValue(skills: Record<string, number> | undefined, sales: Sale[], ranges?: StatRanges | null): Valuation | null {
  if (!sales.length) return null;
  const own = skills ?? {};
  const spans = rangesFor(own, sales, ranges);
  const keys = Object.keys(spans);
  if (!keys.length) return { price: median(sales.slice(0, VALUE_SAMPLES).map((s) => s.price)), basis: 'similar', samples: Math.min(VALUE_SAMPLES, sales.length) };
  const distance = (s: Sale) =>
    Math.hypot(
      ...keys.map((k) => {
        const [lo, hi] = spans[k];
        return ((own[k] ?? lo) - (s.skills[k] ?? lo)) / Math.max(1, hi - lo);
      }),
    );
  const ranked = sales
    .map((s) => ({ s, d: distance(s) }))
    .sort((x, y) => x.d - y.d || (x.s.at < y.s.at ? 1 : x.s.at > y.s.at ? -1 : 0))
    .slice(0, VALUE_SAMPLES);
  return {
    price: median(ranked.map((r) => r.s.price)),
    basis: ranked.every((r) => r.d === 0) ? 'identical' : 'similar',
    samples: ranked.length,
  };
}

export interface Balance {
  /** Gewertete Kisten. */
  opened: number;
  /** Kistenpreis mal Anzahl, null ohne Kistenpreis. */
  cost: number | null;
  /** Summe der geschätzten Itemwerte. */
  loot: number;
  /** Öffnungen ohne Schätzung (noch unterwegs oder kein Preis). */
  missing: number;
  /** Beute minus Einsatz, null ohne Kistenpreis. */
  net: number | null;
}

export function balance(openings: Opening[], casePrice: number | null | undefined, values: Record<string, Valuation | null | undefined>): Balance {
  let loot = 0;
  let missing = 0;
  for (const o of openings) {
    const v = values[o.id];
    if (v) loot += v.price;
    else missing++;
  }
  const cost = typeof casePrice === 'number' && casePrice > 0 ? casePrice * openings.length : null;
  return { opened: openings.length, cost, loot, missing, net: cost === null ? null : loot - cost };
}

// ------------------------------------------------------------------ Demo

/**
 * Seltenheiten der roten Kiste: Artikel "Opening Cases: Is It Actually Worth It?" (warera.io, Mai 2026),
 * gegengeprüft an 100 Öffnungen aus der API (47/34/17/2/0). Gewöhnliches kommt nicht vor.
 */
export const ELITE_ODDS: [Rarity, number][] = [
  ['uncommon', 0.5],
  ['rare', 0.32],
  ['epic', 0.15],
  ['legendary', 0.025],
  ['mythic', 0.005],
];

const WEAPON_BY_RARITY: Record<Rarity, string> = {
  common: 'knife',
  uncommon: 'gun',
  rare: 'rifle',
  epic: 'sniper',
  legendary: 'tank',
  mythic: 'jet',
};

const SLOTS = ['helmet', 'chest', 'pants', 'boots', 'gloves'];

/** Zieht ein Item wie aus einer roten Kiste (30 % Waffe laut Spielkonfiguration, sonst Ausrüstung). */
export function rollEliteItem(rng: () => number = Math.random): { code: string; rarity: Rarity } {
  let roll = rng();
  let rarity: Rarity = ELITE_ODDS[0][0];
  for (const [r, p] of ELITE_ODDS) {
    rarity = r;
    if (roll < p) break;
    roll -= p;
  }
  if (rng() < 0.3) return { code: WEAPON_BY_RARITY[rarity], rarity };
  const slot = SLOTS[Math.floor(rng() * SLOTS.length) % SLOTS.length];
  return { code: `${slot}${rarityRank(rarity) + 1}`, rarity };
}
