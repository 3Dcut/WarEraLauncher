// Reine Spiellogik des Kisten-Battles, ohne DOM und Netz, damit sie sich testen lässt.
//
// Regeln: Zwei Spieler öffnen abwechselnd Kisten. Die n-te Öffnung von A tritt gegen die
// n-te Öffnung von B an; die seltenere Item-Kategorie (Seltenheit) gewinnt die Runde und
// bringt einen Punkt, gleiche Seltenheit ist ein Gleichstand ohne Punkt. Wer zuerst das
// Punkteziel erreicht, gewinnt; spätere Öffnungen zählen nicht mehr.

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type Rarity = (typeof RARITIES)[number];
export type Side = 0 | 1;

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Gewöhnlich',
  uncommon: 'Ungewöhnlich',
  rare: 'Selten',
  epic: 'Episch',
  legendary: 'Legendär',
  mythic: 'Mythisch',
};

export function isRarity(value: unknown): value is Rarity {
  return typeof value === 'string' && (RARITIES as readonly string[]).includes(value);
}

/** 0 (gewöhnlich) bis 5 (mythisch), -1 für unbekannte Items. */
export function rarityRank(rarity: Rarity | null | undefined): number {
  return rarity ? RARITIES.indexOf(rarity) : -1;
}

// ------------------------------------------------------------------ Kisten

export interface CaseType {
  code: string | null;
  name: string;
  /** Kurz für Plaketten. */
  short: string;
  /** Im Satz, etwa "Abwechselnd öffnet ihr rote Kisten". */
  plural: string;
}

/** Kistentypen laut Spielkonfiguration; null = jede Kiste zählt. */
export const CASE_TYPES: CaseType[] = [
  { code: 'case2', name: 'Rote Kiste (Elite)', short: 'Rote Kisten', plural: 'rote Kisten' },
  { code: 'case1', name: 'Grüne Kiste', short: 'Grüne Kisten', plural: 'grüne Kisten' },
  { code: 'woodenCase', name: 'Holzkiste', short: 'Holzkisten', plural: 'Holzkisten' },
  { code: 'toolbox', name: 'Werkzeugkiste', short: 'Werkzeugkisten', plural: 'Werkzeugkisten' },
  { code: null, name: 'Jede Kiste', short: 'Alle Kisten', plural: 'beliebige Kisten' },
];

export function caseType(code: string | null | undefined): CaseType {
  return CASE_TYPES.find((c) => c.code === (code ?? null)) ?? CASE_TYPES[0];
}

// ------------------------------------------------------------------ Items

const EQUIPMENT: Record<string, { name: string; emoji: string }> = {
  helmet: { name: 'Helm', emoji: '🪖' },
  chest: { name: 'Brustpanzer', emoji: '🦺' },
  pants: { name: 'Hose', emoji: '👖' },
  boots: { name: 'Stiefel', emoji: '🥾' },
  gloves: { name: 'Handschuhe', emoji: '🧤' },
  sickle: { name: 'Sichel', emoji: '🌾' },
  pickaxe: { name: 'Spitzhacke', emoji: '⛏️' },
  skillet: { name: 'Pfanne', emoji: '🍳' },
  hammer: { name: 'Hammer', emoji: '🔨' },
  flask: { name: 'Kolben', emoji: '⚗️' },
  caliper: { name: 'Messschieber', emoji: '📏' },
};

const WEAPONS: Record<string, { name: string; emoji: string; rarity: Rarity }> = {
  knife: { name: 'Messer', emoji: '🔪', rarity: 'common' },
  gun: { name: 'Pistole', emoji: '🔫', rarity: 'uncommon' },
  rifle: { name: 'Gewehr', emoji: '🎯', rarity: 'rare' },
  sniper: { name: 'Scharfschützengewehr', emoji: '🔭', rarity: 'epic' },
  tank: { name: 'Panzer', emoji: '💥', rarity: 'legendary' },
  jet: { name: 'Kampfjet', emoji: '✈️', rarity: 'mythic' },
};

const SKILL_LABEL: Record<string, string> = {
  attack: 'Angriff',
  criticalChance: 'Krit-Chance',
  criticalDamages: 'Krit-Schaden',
  armor: 'Rüstung',
  precision: 'Präzision',
  dodge: 'Ausweichen',
  production: 'Produktion',
};

export interface ItemInfo {
  name: string;
  emoji: string;
}

export function itemInfo(code: string): ItemInfo {
  const weapon = WEAPONS[code];
  if (weapon) return { name: weapon.name, emoji: weapon.emoji };
  const m = /^([a-z]+?)(\d)$/i.exec(code);
  const base = m ? EQUIPMENT[m[1]] : undefined;
  if (base) return { name: base.name, emoji: base.emoji };
  return { name: code, emoji: '📦' };
}

/**
 * Seltenheit ohne Spielkonfiguration: Ausrüstung und Werkzeuge tragen die Stufe als Ziffer
 * (helmet1 = gewöhnlich … helmet6 = mythisch), Waffen haben feste Stufen.
 */
export function fallbackRarity(code: string): Rarity | null {
  const weapon = WEAPONS[code];
  if (weapon) return weapon.rarity;
  const m = /^([a-z]+?)(\d)$/i.exec(code);
  if (m && EQUIPMENT[m[1]]) {
    const tier = Number(m[2]);
    if (tier >= 1 && tier <= 6) return RARITIES[tier - 1];
  }
  return null;
}

export function formatSkills(skills: Record<string, number> | undefined): string {
  if (!skills) return '';
  return Object.entries(skills)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${SKILL_LABEL[k] ?? k} ${v}`)
    .join(' · ');
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

/** Ausschnitt einer Transaktion vom Typ openCase, wie sie transaction.getPaginatedTransactions liefert. */
export interface RawTransaction {
  _id?: string;
  transactionType?: string;
  itemCode?: string;
  buyerId?: string;
  sellerId?: string;
  createdAt?: string;
  item?: { code?: string; skills?: Record<string, number> } | null;
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
