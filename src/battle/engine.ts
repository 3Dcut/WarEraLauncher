// Ablauf eines Kisten-Battles: Stand vor dem Start festhalten, beide Spieler laufend abfragen,
// neue Öffnungen nacheinander mit Animation aufdecken und werten, nebenher jedes gezogene Item
// am Markt bewerten. Der Zustand liegt in Signals, damit die Oberfläche nur abbildet, was hier
// entschieden wird.

import { signal, computed, batch as batchSignals } from '@preact/signals';
import {
  evaluate,
  makeBaseline,
  freshOpenings,
  rarityRank,
  rollEliteItem,
  byTime,
  balance,
  estimateValue,
  type Balance,
  type Baseline,
  type Opening,
  type Round,
  type Sale,
  type Side,
  type Valuation,
} from './logic';
import {
  ApiError,
  fetchAverages,
  fetchCasePrices,
  fetchOpenings,
  fetchSales,
  rarityOf,
  statRangesOf,
  type OpeningsQuery,
  type Player,
} from './api';
import { sfx } from './sound';
import { emit } from './events';
import { TARGET } from './logic';
import { t } from '../i18n';

export type Phase = 'setup' | 'arming' | 'live' | 'finished';

export interface Match {
  players: [Player, Player];
  caseCode: string | null;
  target: number;
  baselines: [Baseline, Baseline];
  openings: [Opening[], Opening[]];
  startedAt: number;
  demo: boolean;
  /** Tipp der Zuschauerin bzw. des Zuschauers an diesem Gerät (Vorstufe für Cardera-Wetten). */
  tip: Side | null;
  /** Marktpreis einer Kiste beim Start; null, solange er fehlt. */
  casePrice?: number | null;
  /** Geschätzter Verkaufswert je Öffnung (ID); null heißt: kein Marktpreis gefunden. */
  values?: Record<string, Valuation | null>;
}

export type Slot =
  | { kind: 'idle' }
  | { kind: 'shake'; opening: Opening }
  | { kind: 'open'; opening: Opening; result?: 'win' | 'lose' | 'tie' };

export interface PollInfo {
  /** Gewünschte Abfragen pro Sekunde. */
  rate: number;
  /** Tatsächlich erreichte Abfragen pro Sekunde (gleitend über 5 s). */
  actual: number;
  lastOkAt: number;
  throttledUntil: number;
  errors: number;
  message: string | null;
}

const MATCH_KEY = 'wb:match';

/**
 * Abfragen pro Sekunde. Drei reichen, damit eine Öffnung praktisch sofort erscheint, und lassen
 * vom Limit (500 pro Minute mit Schlüssel) genug für die Preisabfragen und andere Tools übrig.
 */
const RATE = 3;

// ------------------------------------------------------------------ Zustand

export const phase = signal<Phase>('setup');
export const match = signal<Match | null>(null);
/** Wie viele Öffnungen je Seite bereits aufgedeckt und gewertet sind. */
export const revealed = signal<[number, number]>([0, 0]);
export const slots = signal<[Slot, Slot]>([{ kind: 'idle' }, { kind: 'idle' }]);
export const lastRound = signal<Round | null>(null);
export const banner = signal<{ tone: 'legendary' | 'mythic'; id: number } | null>(null);
export const poll = signal<PollInfo>({ rate: RATE, actual: 0, lastOkAt: 0, throttledUntil: 0, errors: 0, message: null });
export const fatal = signal<string | null>(null);
/** Ob der letzte harte Fehler am API-Schlüssel lag (dann zeigt die Einrichtung das Schlüsselfeld). */
export const keyRejected = signal(false);


export const standing = computed(() => {
  const m = match.value;
  const [ra, rb] = revealed.value;
  if (!m) return evaluate([], [], 3);
  return evaluate(m.openings[0].slice(0, ra), m.openings[1].slice(0, rb), m.target);
});

/** Ungewertete Öffnungen je Seite, etwa für "wartet noch"-Anzeigen. */
export const backlog = computed<[number, number]>(() => {
  const m = match.value;
  if (!m) return [0, 0];
  return [m.openings[0].length - revealed.value[0], m.openings[1].length - revealed.value[1]];
});

/** Einsatz, Beute und Bilanz je Seite über die gewerteten Öffnungen. */
export const balances = computed<[Balance, Balance] | null>(() => {
  const m = match.value;
  if (!m) return null;
  const s = standing.value;
  const counted = (side: Side): Opening[] =>
    s.winner !== null ? s.rounds.map((r) => (side === 0 ? r.a : r.b)) : m.openings[side].slice(0, revealed.value[side]);
  const values = m.values ?? {};
  return [balance(counted(0), m.casePrice, values), balance(counted(1), m.casePrice, values)];
});

// ------------------------------------------------------------------ Hilfen

let generation = 0;
/** Schlüssel für die Abfrage der Öffnungen (nur im echten Spiel). */
let apiKey: string | null = null;
/** Schlüssel für die Bewertung am Markt; auch in der Demo, falls einer hinterlegt ist. */
let valueKey: string | null = null;
let reduced = false;

export function setReducedMotion(value: boolean): void {
  reduced = value;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, reduced ? Math.min(ms, 350) : ms));

function persist(): void {
  try {
    const m = match.value;
    if (!m || phase.value === 'setup') localStorage.removeItem(MATCH_KEY);
    else localStorage.setItem(MATCH_KEY, JSON.stringify({ ...m, phase: phase.value }));
  } catch {
    /* gesperrter Speicher */
  }
}

function updateMatch(patch: Partial<Match>): void {
  if (!match.value) return;
  match.value = { ...match.value, ...patch };
  persist();
}

let bannerSeq = 0;
function showBanner(tone: 'legendary' | 'mythic'): void {
  const id = ++bannerSeq;
  banner.value = { tone, id };
  setTimeout(() => {
    if (banner.value?.id === id) banner.value = null;
  }, 2600);
}

// ------------------------------------------------------------------ Start, Ende, Wiederaufnahme

export interface StartOptions {
  players: [Player, Player];
  caseCode: string;
  /** Hinterlegter Schlüssel; in der Demo nur für die Bewertung genutzt. */
  key: string | null;
  demo: boolean;
}

export async function startMatch(opts: StartOptions): Promise<void> {
  const gen = ++generation;
  apiKey = opts.demo ? null : opts.key;
  valueKey = opts.key;
  fatal.value = null;
  keyRejected.value = false;
  phase.value = 'arming';
  poll.value = { ...poll.value, rate: RATE, errors: 0, message: null, throttledUntil: 0, actual: 0 };
  let baselines: [Baseline, Baseline] = [makeBaseline([]), makeBaseline([])];
  if (!opts.demo) {
    try {
      const pages = await fetchOpenings(queriesFor(opts.players, opts.caseCode, 20), opts.key!);
      baselines = [makeBaseline(pages[0].openings), makeBaseline(pages[1].openings)];
    } catch (err) {
      if (gen !== generation) return;
      phase.value = 'setup';
      fatal.value = describeError(err);
      keyRejected.value = isKeyError(err);
      return;
    }
  }
  if (gen !== generation) return;
  batchSignals(() => {
    match.value = {
      players: opts.players,
      caseCode: opts.caseCode,
      target: TARGET,
      baselines,
      openings: [[], []],
      startedAt: Date.now(),
      demo: opts.demo,
      tip: null,
      casePrice: null,
      values: {},
    };
    revealed.value = [0, 0];
    slots.value = [{ kind: 'idle' }, { kind: 'idle' }];
    lastRound.value = null;
    phase.value = 'live';
  });
  persist();
  void loadCasePrice(match.value!.startedAt, opts.caseCode);
  sfx.start();
  emit('start', { players: opts.players.map((p) => p.name), target: TARGET, caseCode: opts.caseCode });
  if (opts.demo) void demoLoop(gen);
  else void pollLoop(gen);
}

/** Setzt ein nach Neuladen gefundenes Spiel fort, ohne bereits Gesehenes erneut zu animieren. */
export function resumeStored(key: string | null): boolean {
  let stored: (Match & { phase?: Phase }) | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(MATCH_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored?.players || !stored.openings) return false;
  if (!stored.demo && !key) return false;
  const gen = ++generation;
  apiKey = stored.demo ? null : key;
  valueKey = key;
  const { phase: storedPhase, ...m } = stored;
  const s = evaluate(m.openings[0], m.openings[1], m.target);
  batchSignals(() => {
    match.value = m;
    revealed.value = [m.openings[0].length, m.openings[1].length];
    slots.value = [{ kind: 'idle' }, { kind: 'idle' }];
    lastRound.value = s.rounds[s.rounds.length - 1] ?? null;
    phase.value = s.winner !== null || storedPhase === 'finished' ? 'finished' : 'live';
  });
  if (phase.value === 'live') {
    if (m.demo) void demoLoop(gen);
    else void pollLoop(gen);
  }
  if (typeof m.casePrice !== 'number') void loadCasePrice(m.startedAt, m.caseCode ?? 'case2');
  requestValues();
  return true;
}

export function stopMatch(): void {
  generation++;
  batchSignals(() => {
    phase.value = 'setup';
    match.value = null;
    lastRound.value = null;
    slots.value = [{ kind: 'idle' }, { kind: 'idle' }];
    banner.value = null;
  });
  persist();
}

function finish(winner: Side): void {
  generation++;
  phase.value = 'finished';
  persist();
  sfx.victory();
  const m = match.value!;
  emit('finish', { winner: m.players[winner].name, points: standing.value.points, rounds: standing.value.rounds.length });
}

// ------------------------------------------------------------------ Abfrage

function queriesFor(players: [Player, Player], caseCode: string | null, limit: number): OpeningsQuery[] {
  return players.map((p) => ({ userId: p.id, caseCode, limit }));
}

function isKeyError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return t('battle.err.keyRejected');
    if (err.status === 429) return t('battle.err.throttled');
    if (err.status === 0) return err.message === 'timeout' ? t('battle.err.timeout') : t('battle.err.offline');
    return t('battle.err.api', { message: err.message });
  }
  return t('battle.err.unexpected');
}

const doneTimes: number[] = [];
let lastThrottleAt = 0;
let throttleLevel = 0;

function effectiveInterval(): number {
  const base = 1000 / Math.max(0.5, poll.value.rate);
  // Nach einer Drosselung schrittweise langsamer, nach 30 ruhigen Sekunden wieder voll
  if (throttleLevel > 0 && Date.now() - lastThrottleAt > 30_000) throttleLevel = 0;
  return base * 2 ** throttleLevel;
}

// Bis zu vier Anfragen gleichzeitig, damit auch bei 300–500 ms Antwortzeit der gewünschte Takt erreicht wird
const MAX_INFLIGHT = 4;
// Pro Abfrage nur die jüngsten Öffnungen; mehr auf einmal werden über den Cursor nachgeladen
const POLL_LIMIT = 4;

async function pollLoop(gen: number): Promise<void> {
  let inflight = 0;
  while (gen === generation && phase.value === 'live') {
    const now = Date.now();
    if (now < poll.value.throttledUntil) {
      await new Promise((r) => setTimeout(r, poll.value.throttledUntil - now));
      continue;
    }
    if (inflight < MAX_INFLIGHT) {
      inflight++;
      void pollOnce(gen).finally(() => inflight--);
    }
    await new Promise((r) => setTimeout(r, effectiveInterval()));
  }
}

async function pollOnce(gen: number): Promise<void> {
  const m = match.value;
  if (!m || !apiKey) return;
  try {
    const pages = await fetchOpenings(queriesFor(m.players, m.caseCode, POLL_LIMIT), apiKey);
    if (gen !== generation) return;
    noteSuccess();
    for (const side of [0, 1] as Side[]) {
      let fresh = freshOpenings(pages[side].openings, m.baselines[side], match.value!.openings[side]);
      // Volle Seite nur mit Neuem: weiter zurückblättern, damit bei vielen Öffnungen auf einmal nichts fehlt
      let cursor = pages[side].nextCursor;
      let guard = 0;
      while (fresh.length >= pages[side].size && pages[side].size > 0 && cursor && guard++ < 5) {
        const [more] = await fetchOpenings([{ userId: m.players[side].id, caseCode: m.caseCode, limit: 25, cursor }], apiKey);
        if (gen !== generation) return;
        const older = freshOpenings(more.openings, m.baselines[side], [...match.value!.openings[side], ...fresh]);
        fresh = [...fresh, ...older].sort(byTime);
        if (older.length < more.size) break;
        cursor = more.nextCursor;
      }
      if (fresh.length) addOpenings(side, fresh);
    }
  } catch (err) {
    if (gen !== generation) return;
    if (err instanceof ApiError && err.status === 429) {
      lastThrottleAt = Date.now();
      throttleLevel = Math.min(3, throttleLevel + 1);
      poll.value = { ...poll.value, throttledUntil: Date.now() + 4000, message: t('battle.poll.slower') };
      return;
    }
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      generation++;
      fatal.value = describeError(err);
      keyRejected.value = true;
      phase.value = 'setup';
      persist();
      return;
    }
    poll.value = { ...poll.value, errors: poll.value.errors + 1, message: describeError(err) };
  }
}

function noteSuccess(): void {
  const now = Date.now();
  doneTimes.push(now);
  while (doneTimes.length && now - doneTimes[0] > 5000) doneTimes.shift();
  poll.value = {
    ...poll.value,
    actual: doneTimes.length / 5,
    lastOkAt: now,
    message: now < poll.value.throttledUntil + 3000 ? poll.value.message : null,
  };
}

function addOpenings(side: Side, fresh: Opening[]): void {
  const m = match.value;
  if (!m) return;
  const openings: [Opening[], Opening[]] = [m.openings[0], m.openings[1]];
  openings[side] = [...openings[side], ...fresh].sort(byTime);
  updateMatch({ openings });
  requestValues();
  void runReveals();
}

// ------------------------------------------------------------------ Bewertung am Markt

/** Gehört der laufende Zustand noch zu dem Spiel, für das eine Abfrage gestartet wurde? */
const sameMatch = (startedAt: number) => match.value?.startedAt === startedAt;

let casePrices: { at: number; table: Record<string, number> } | null = null;

async function loadCasePrice(startedAt: number, caseCode: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!casePrices || Date.now() - casePrices.at > 3 * 60_000) casePrices = { at: Date.now(), table: await fetchCasePrices() };
      const price = casePrices.table[caseCode];
      if (sameMatch(startedAt)) updateMatch({ casePrice: typeof price === 'number' && price > 0 ? price : null });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      if (!sameMatch(startedAt)) return;
    }
  }
}

const salesCache = new Map<string, { at: number; sales: Sale[] }>();
const SALES_TTL = 10 * 60_000;
/** Höchstens so viele Itemcodes je Anfrage (jeder bringt bis zu 100 Verkäufe mit). */
const SALES_BATCH = 6;
const valuing = new Set<string>();
let valueTimer: ReturnType<typeof setTimeout> | null = null;
let valueFailures = 0;

/** Bewertet alle Öffnungen ohne Wert, gebündelt und leicht verzögert. */
function requestValues(delay = 250): void {
  if (valueTimer) return;
  valueTimer = setTimeout(() => {
    valueTimer = null;
    void valueRound();
  }, delay);
}

async function valueRound(): Promise<void> {
  const m = match.value;
  if (!m) return;
  const known = m.values ?? {};
  const todo = [...m.openings[0], ...m.openings[1]].filter((o) => !(o.id in known) && !valuing.has(o.id));
  if (!todo.length) return;
  const startedAt = m.startedAt;
  todo.forEach((o) => valuing.add(o.id));
  const resolved: Record<string, Valuation | null> = {};
  let retry = false;
  try {
    const now = Date.now();
    const codes = [...new Set(todo.map((o) => o.itemCode))];
    const stale = codes.filter((c) => !salesCache.has(c) || now - salesCache.get(c)!.at > SALES_TTL).slice(0, SALES_BATCH);
    const noSales = new Set<string>();
    if (stale.length && valueKey) {
      const results = await fetchSales(stale, valueKey);
      results.forEach((r, i) => {
        if (r instanceof ApiError) noSales.add(stale[i]);
        else salesCache.set(stale[i], { at: Date.now(), sales: r });
      });
    } else stale.forEach((c) => noSales.add(c));

    // Ohne Schlüssel oder ohne Verkäufe: Durchschnittspreis des Codes, sonst aus den jüngsten Verkäufen
    const avgCodes = codes.filter((c) => noSales.has(c) || salesCache.get(c)?.sales.length === 0);
    const averages: Record<string, number> = {};
    if (avgCodes.length) {
      const res = await fetchAverages(avgCodes);
      res.forEach((r, i) => {
        if (typeof r === 'number' && r > 0) averages[avgCodes[i]] = r;
      });
    }
    for (const o of todo) {
      const cached = salesCache.get(o.itemCode);
      if (!cached && !noSales.has(o.itemCode)) continue; // Code passte nicht mehr in diese Anfrage
      const sales = cached?.sales ?? [];
      const v = sales.length ? estimateValue(o.skills, sales, statRangesOf(o.itemCode)) : null;
      const avg = averages[o.itemCode];
      resolved[o.id] = v ?? (avg ? { price: avg, basis: 'average', samples: 0 } : null);
    }
    valueFailures = 0;
  } catch (err) {
    // Netz oder Drosselung: später erneut, mit wachsender Pause
    retry = true;
    valueFailures++;
    if (!(err instanceof ApiError && err.status === 429)) console.warn('[Battle] Bewertung fehlgeschlagen', err);
  } finally {
    todo.forEach((o) => valuing.delete(o.id));
  }
  if (!sameMatch(startedAt)) return;
  if (Object.keys(resolved).length) updateMatch({ values: { ...(match.value!.values ?? {}), ...resolved } });
  const left = [...match.value!.openings[0], ...match.value!.openings[1]].some((o) => !(o.id in (match.value!.values ?? {})));
  if (left && (!retry || valueFailures < 6)) requestValues(retry ? Math.min(30_000, 2000 * 2 ** valueFailures) : 250);
}

// ------------------------------------------------------------------ Aufdecken mit Animation

let animating = false;

/** Nächste Öffnung, die aufgedeckt werden darf: jede Seite höchstens eine pro Runde, älteste zuerst. */
function nextReveal(): { side: Side; opening: Opening } | null {
  const m = match.value;
  if (!m || standing.value.winner !== null) return null;
  const round = standing.value.rounds.length;
  const candidates: { side: Side; opening: Opening }[] = [];
  for (const side of [0, 1] as Side[]) {
    const idx = revealed.value[side];
    if (idx === round && m.openings[side][idx]) candidates.push({ side, opening: m.openings[side][idx] });
  }
  candidates.sort((x, y) => byTime(x.opening, y.opening));
  return candidates[0] ?? null;
}

function setSlot(side: Side, slot: Slot): void {
  const next: [Slot, Slot] = [slots.value[0], slots.value[1]];
  next[side] = slot;
  slots.value = next;
}

async function runReveals(): Promise<void> {
  if (animating) return;
  animating = true;
  const gen = generation;
  try {
    let next = nextReveal();
    while (next && gen === generation) {
      const { side, opening } = next;
      const name = match.value!.players[side].name;
      setSlot(side, { kind: 'shake', opening });
      sfx.shake();
      await wait(1150);
      if (gen !== generation) return;
      setSlot(side, { kind: 'open', opening });
      const rank = rarityRank(opening.rarity);
      sfx.reveal(rank);
      if (rank >= 4) showBanner(rank >= 5 ? 'mythic' : 'legendary');
      emit('open', { player: name, item: opening.itemCode, rarity: opening.rarity });
      await wait(950);
      if (gen !== generation) return;

      const roundsBefore = standing.value.rounds.length;
      const r = [...revealed.value] as [number, number];
      r[side]++;
      revealed.value = r;
      const s = standing.value;
      if (s.rounds.length > roundsBefore) {
        const round = s.rounds[s.rounds.length - 1];
        lastRound.value = round;
        slots.value = [
          { kind: 'open', opening: round.a, result: round.winner === null ? 'tie' : round.winner === 0 ? 'win' : 'lose' },
          { kind: 'open', opening: round.b, result: round.winner === null ? 'tie' : round.winner === 1 ? 'win' : 'lose' },
        ];
        if (round.winner === null) sfx.tie();
        else sfx.point();
        emit('round', {
          round: round.index,
          winner: round.winner === null ? null : match.value!.players[round.winner].name,
          points: s.points,
        });
        await wait(s.winner !== null ? 1400 : 2300);
        if (gen !== generation) return;
        if (s.winner !== null) {
          finish(s.winner);
          return;
        }
        slots.value = [{ kind: 'idle' }, { kind: 'idle' }];
        await wait(250);
      }
      next = nextReveal();
    }
  } finally {
    animating = false;
  }
}

// ------------------------------------------------------------------ Demo

let demoSeq = 0;

async function demoLoop(gen: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 900));
  while (gen === generation && phase.value === 'live') {
    const m = match.value!;
    const known = evaluate(m.openings[0], m.openings[1], m.target);
    if (known.winner !== null) return;
    const side = known.turn;
    const item = rollEliteItem();
    const opening: Opening = {
      id: `demo${Date.now().toString(16)}${(demoSeq++).toString(16).padStart(4, '0')}`,
      at: new Date().toISOString(),
      caseCode: m.caseCode ?? 'case2',
      itemCode: item.code,
      rarity: rarityOf(item.code) ?? item.rarity,
      skills: demoSkills(item.code, rarityRank(item.rarity)),
    };
    addOpenings(side, [opening]);
    await new Promise((r) => setTimeout(r, reduced ? 900 : 1700 + Math.random() * 1600));
  }
}

function demoSkills(code: string, rank: number): Record<string, number> {
  const roll = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));
  // Echte Spannen aus der Spielkonfiguration, damit auch die Demo-Preise stimmen
  const ranges = statRangesOf(code);
  if (ranges) return Object.fromEntries(Object.entries(ranges).map(([stat, [lo, hi]]) => [stat, roll(lo, hi)]));
  if (/^(gun|rifle|sniper|tank|jet|knife)$/.test(code)) return { attack: roll(30 + rank * 25, 50 + rank * 30), criticalChance: roll(2 + rank * 2, 6 + rank * 3) };
  const stat = code.startsWith('helmet') ? 'criticalDamages' : code.startsWith('gloves') ? 'precision' : code.startsWith('boots') ? 'dodge' : 'armor';
  return { [stat]: roll(1 + rank * 5, 5 + rank * 6) };
}
