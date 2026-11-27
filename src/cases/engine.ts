// Ablauf des Kisten-Assistenten: Sitzung starten (Stand merken oder rückwirkend laden), Öffnungen
// des Spielers laufend abfragen, Zerlegungen und Verkäufe den Ziehungen zuordnen, Kisten-, Schrott-
// und Itemmärkte beobachten. Alles Abgeleitete (Empfehlungen, Summen, Glück) rechnet stats.ts.

import { signal, batch as batchSignals } from '@preact/signals';
import { ApiError, fetchTx, fetchTxUntil, fetchBooks, fetchHistory, fetchPrices, type Book, type TradingDay } from '../assist/api';
import { fetchSales, fetchAverages, loadItemConfig, rarityOf, statRangesOf } from '../battle/api';
import type { RawTransaction, Sale } from '../battle/logic';
import { byTime, caseCodes, CASE_ODDS, codesOf, matchOutcomes, toPull, type CaseCode, type DismantleTx, type MarketTx, type Outcome, type Pull } from './logic';
import { RARITIES, type Rarity } from '../battle/logic';
import { t } from '../i18n';

export type Since = 'now' | '1h' | '24h';

export interface Session {
  userId: string;
  name: string;
  startedAt: number;
  /** Serverzeit (ISO), ab der Öffnungen zählen. */
  since: string | null;
  /** Öffnungen, die beim Start schon da waren. */
  seen: string[];
  pulls: Pull[];
  outcomes: Record<string, Outcome>;
  live: boolean;
  demo: boolean;
}

export interface Market {
  prices: Record<string, number>;
  books: Record<string, Book>;
  history: Record<string, TradingDay[]>;
  at: number;
}

const SESSION_KEY = 'wca:session';

export const session = signal<Session | null>(null);
export const market = signal<Market>({ prices: {}, books: {}, history: {}, at: 0 });
/** Jüngste Verkäufe je Itemcode (für Schätzungen und den Erwartungswert). */
export const sales = signal<Record<string, Sale[]>>({});
/** Durchschnittspreise je Code, falls keine Verkäufe abrufbar sind (ohne Schlüssel). */
export const averages = signal<Record<string, number>>({});
export const status = signal<{ state: 'idle' | 'arming' | 'live' | 'stale' | 'throttled' | 'error'; message: string | null; lastOkAt: number }>({
  state: 'idle',
  message: null,
  lastOkAt: 0,
});
export const keyRejected = signal(false);

let generation = 0;
let key: string | null = null;

function persist(): void {
  try {
    const s = session.value;
    if (!s) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* Speicher voll oder gesperrt */
  }
}

function patch(p: Partial<Session>): void {
  if (!session.value) return;
  session.value = { ...session.value, ...p };
  persist();
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return t('cases.err.keyRejected');
    if (err.status === 429) return t('cases.err.throttled');
    if (err.status === 0) return err.message === 'timeout' ? t('cases.err.timeout') : t('cases.err.offline');
    return t('cases.err.api', { message: err.message });
  }
  return t('cases.err.unexpected');
}

const isKeyError = (err: unknown) => err instanceof ApiError && (err.status === 401 || err.status === 403);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ Start, Ende, Wiederaufnahme

export interface StartOptions {
  userId: string;
  name: string;
  since: Since;
  key: string | null;
  demo?: boolean;
}

export async function startSession(opts: StartOptions): Promise<void> {
  const gen = ++generation;
  key = opts.key;
  keyRejected.value = false;
  status.value = { state: 'arming', message: null, lastOkAt: 0 };
  let since: string | null = null;
  let seen: string[] = [];
  let pulls: Pull[] = [];
  if (!opts.demo) {
    try {
      if (opts.since === 'now') {
        const [page] = await fetchTx<RawTransaction>([{ userId: opts.userId, types: ['openCase'], limit: 25 }], opts.key!);
        const sorted = [...page.items].filter((tx) => tx.createdAt).sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : 1));
        since = sorted.length ? sorted[sorted.length - 1].createdAt! : null;
        seen = sorted.map((tx) => tx._id!).filter(Boolean);
      } else {
        since = new Date(Date.now() - (opts.since === '1h' ? 3600_000 : 24 * 3600_000)).toISOString();
        const back = await fetchTxUntil<RawTransaction>(
          { userId: opts.userId, types: ['openCase'], limit: 100 },
          opts.key!,
          (tx) => !!tx.createdAt && tx.createdAt < since!,
          80,
        );
        const cost = (c: CaseCode) => market.value.prices[c] ?? null;
        pulls = back.items
          .map((tx) => toPull(tx, opts.userId, rarityOf))
          .filter((p): p is Omit<Pull, 'cost'> => !!p)
          .map((p) => ({ ...p, cost: cost(p.caseCode) }))
          .sort(byTime);
      }
    } catch (err) {
      if (gen !== generation) return;
      status.value = { state: 'error', message: describe(err), lastOkAt: 0 };
      keyRejected.value = isKeyError(err);
      return;
    }
  }
  if (gen !== generation) return;
  session.value = { userId: opts.userId, name: opts.name, startedAt: Date.now(), since, seen, pulls, outcomes: {}, live: true, demo: !!opts.demo };
  persist();
  status.value = { state: 'live', message: null, lastOkAt: Date.now() };
  void ensureSales();
  if (opts.demo) void demoLoop(gen);
  else {
    void pollLoop(gen);
    void outcomeLoop(gen);
  }
}

/** Setzt eine gespeicherte Sitzung nach dem Neuladen fort. */
export function resumeSession(k: string | null): boolean {
  let stored: Session | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored?.userId || !Array.isArray(stored.pulls)) return false;
  key = k;
  const gen = ++generation;
  session.value = { ...stored, outcomes: stored.outcomes ?? {} };
  void ensureSales();
  if (stored.live && (stored.demo || k)) {
    status.value = { state: 'live', message: null, lastOkAt: 0 };
    if (stored.demo) void demoLoop(gen);
    else {
      void pollLoop(gen);
      void outcomeLoop(gen);
    }
  } else if (stored.live) {
    patch({ live: false });
  }
  return true;
}

/** Hält die Live-Abfrage an; die Auswertung bleibt stehen. */
export function stopSession(): void {
  generation++;
  patch({ live: false });
  status.value = { ...status.value, state: 'idle' };
}

/** Setzt eine angehaltene Sitzung fort: Öffnungen dazwischen werden nachgeholt. */
export function continueSession(k: string | null): void {
  const s = session.value;
  if (!s || s.live) return;
  key = k;
  const gen = ++generation;
  patch({ live: true });
  status.value = { state: 'live', message: null, lastOkAt: 0 };
  if (s.demo) void demoLoop(gen);
  else {
    void pollLoop(gen);
    void outcomeLoop(gen);
  }
}

export function clearSession(): void {
  generation++;
  session.value = null;
  persist();
  status.value = { state: 'idle', message: null, lastOkAt: 0 };
}

// ------------------------------------------------------------------ Öffnungen

const POLL_MS = 1500;

function known(): Set<string> {
  const s = session.value!;
  return new Set([...s.seen, ...s.pulls.map((p) => p.id)]);
}

function addPulls(fresh: Pull[]): void {
  const s = session.value;
  if (!s || !fresh.length) return;
  const have = new Set(s.pulls.map((p) => p.id));
  const add = fresh.filter((p) => !have.has(p.id) && have.add(p.id));
  if (!add.length) return;
  patch({ pulls: [...s.pulls, ...add].sort(byTime) });
  void ensureSales();
}

let throttle = 0;

async function pollLoop(gen: number): Promise<void> {
  while (gen === generation) {
    await pollOnce(gen);
    await sleep(POLL_MS * 2 ** throttle);
  }
}

async function pollOnce(gen: number): Promise<void> {
  const s = session.value;
  if (!s || !key) return;
  try {
    const [page] = await fetchTx<RawTransaction>([{ userId: s.userId, types: ['openCase'], limit: 25 }], key);
    if (gen !== generation) return;
    const have = known();
    const isOld = (tx: RawTransaction) => !tx._id || have.has(tx._id) || (!!s.since && !!tx.createdAt && tx.createdAt < s.since);
    let items = page.items.filter((tx) => !isOld(tx));
    // Ganze Seite neu (etwa "Alle öffnen"): weiter zurückblättern, bis Bekanntes auftaucht
    if (items.length === page.items.length && page.nextCursor && items.length) {
      const more = await fetchTxUntil<RawTransaction>({ userId: s.userId, types: ['openCase'], limit: 100, cursor: page.nextCursor }, key, isOld, 60);
      if (gen !== generation) return;
      items = [...items, ...more.items];
    }
    const cost = (c: CaseCode) => market.value.prices[c] ?? null;
    const fresh = items
      .map((tx) => toPull(tx, s.userId, rarityOf))
      .filter((p): p is Omit<Pull, 'cost'> => !!p)
      .map((p) => ({ ...p, cost: cost(p.caseCode) }));
    // Andere Kisten (Holzkiste, Werkzeugkasten) nur als gesehen merken
    const other = items.filter((tx) => tx._id && !fresh.some((p) => p.id === tx._id)).map((tx) => tx._id!);
    if (other.length) patch({ seen: [...session.value!.seen, ...other] });
    addPulls(fresh);
    throttle = Math.max(0, throttle - 1);
    status.value = { state: 'live', message: null, lastOkAt: Date.now() };
  } catch (err) {
    if (gen !== generation) return;
    if (isKeyError(err)) {
      generation++;
      keyRejected.value = true;
      patch({ live: false });
      status.value = { state: 'error', message: describe(err), lastOkAt: status.value.lastOkAt };
      return;
    }
    if (err instanceof ApiError && err.status === 429) throttle = Math.min(3, throttle + 1);
    status.value = { ...status.value, state: err instanceof ApiError && err.status === 429 ? 'throttled' : 'stale', message: describe(err) };
  }
}

// ------------------------------------------------------------------ Zerlegt oder verkauft?

const OUTCOME_MS = 12_000;
let outcomeWatermark: string | null = null;

async function outcomeLoop(gen: number): Promise<void> {
  outcomeWatermark = null;
  await sleep(2000);
  while (gen === generation) {
    await outcomesOnce(gen);
    await sleep(OUTCOME_MS * 2 ** throttle);
  }
}

/** Einmal abfragen, etwa nach dem Neuladen einer beendeten Sitzung. */
export async function refreshOutcomes(): Promise<void> {
  if (!key) return;
  outcomeWatermark = null;
  await outcomesOnce(generation);
}

async function outcomesOnce(gen: number): Promise<void> {
  const s = session.value;
  if (!s || !key || !s.pulls.length) return;
  const open = s.pulls.filter((p) => !s.outcomes[p.id]);
  if (!open.length) return;
  const floor = [s.since ?? s.pulls[0].at, outcomeWatermark]
    .filter((v): v is string => !!v)
    .sort()
    .pop()!;
  try {
    const res = await fetchTxUntil<DismantleTx & MarketTx>(
      { userId: s.userId, types: ['dismantleItem', 'itemMarket'], limit: 100 },
      key,
      (tx) => !!tx.createdAt && tx.createdAt < floor,
      30,
    );
    if (gen !== generation || !session.value) return;
    const found = matchOutcomes(open, s.userId, res.items, res.items);
    // Nächstes Mal nur noch die letzten Minuten nachsehen (Verkäufe können später eintreffen, Zerlegungen nicht rückwirkend)
    const newest = res.items
      .map((tx) => tx.createdAt!)
      .filter(Boolean)
      .sort()
      .pop();
    if (newest && res.complete) outcomeWatermark = new Date(Date.parse(newest) - 60_000).toISOString();
    if (Object.keys(found).length) patch({ outcomes: { ...session.value.outcomes, ...found } });
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) throttle = Math.min(3, throttle + 1);
  }
}

// ------------------------------------------------------------------ Märkte

const SALES_TTL = 10 * 60_000;
/** Wann je Code zuletzt Verkäufe (mit Schlüssel) bzw. Durchschnittspreise (ohne) geholt wurden. */
const salesAt = new Map<string, number>();
const avgAt = new Map<string, number>();
let salesBusy = false;

/** Lädt Verkäufe für alle Codes, die aus den beobachteten Kisten kommen können. */
export async function ensureSales(): Promise<void> {
  if (salesBusy) return;
  salesBusy = true;
  try {
    const wanted = [...new Set([...caseCodes('case2'), ...caseCodes('case1'), ...(session.value?.pulls.map((p) => p.itemCode) ?? [])])];
    const now = Date.now();
    if (!key) {
      const stale = wanted.filter((c) => now - (avgAt.get(c) ?? 0) > SALES_TTL && !sales.value[c]);
      if (!stale.length) return;
      const res = await fetchAverages(stale);
      const next = { ...averages.value };
      res.forEach((r, i) => {
        if (typeof r === 'number' && r > 0) next[stale[i]] = r;
        avgAt.set(stale[i], Date.now());
      });
      averages.value = next;
      return;
    }
    const stale = wanted.filter((c) => now - (salesAt.get(c) ?? 0) > SALES_TTL);
    if (!stale.length) return;
    // Seltenes zuerst: dort hängt am meisten Geld an der Schätzung
    stale.sort((a, b) => RARITIES.indexOf(rarityOf(b) ?? 'common') - RARITIES.indexOf(rarityOf(a) ?? 'common'));
    for (let i = 0; i < stale.length && key; i += 6) {
      const chunk = stale.slice(i, i + 6);
      try {
        const res = await fetchSales(chunk, key);
        const next = { ...sales.value };
        res.forEach((r, j) => {
          if (!(r instanceof ApiError)) next[chunk[j]] = r;
          salesAt.set(chunk[j], Date.now());
        });
        sales.value = next;
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) await sleep(5000);
      }
      await sleep(300);
    }
  } finally {
    salesBusy = false;
  }
}

let marketTimer: ReturnType<typeof setTimeout> | null = null;
let historyAt = 0;

/** Kisten- und Schrottmarkt im Blick behalten (Preise alle 3 min, Orderbücher jede Minute, Verlauf alle 30 min). */
export function watchMarket(): void {
  if (marketTimer) return;
  const tick = async () => {
    const m = market.value;
    const now = Date.now();
    try {
      const codes = ['case2', 'case1', 'scraps'];
      const [prices, books] = await Promise.all([
        now - m.at > 3 * 60_000 || !Object.keys(m.prices).length ? fetchPrices() : Promise.resolve(m.prices),
        fetchBooks(codes, 5),
      ]);
      let history = m.history;
      if (now - historyAt > 30 * 60_000) {
        history = await fetchHistory(codes);
        historyAt = now;
      }
      batchSignals(() => {
        market.value = { prices, books, history, at: prices === m.prices ? m.at : now };
      });
      // Kistenpreis für Ziehungen nachtragen, die ohne Preis erkannt wurden
      const s = session.value;
      if (s && s.pulls.some((p) => p.cost === null)) patch({ pulls: s.pulls.map((p) => (p.cost === null ? { ...p, cost: prices[p.caseCode] ?? null } : p)) });
    } catch {
      /* nächster Versuch beim nächsten Takt */
    }
    marketTimer = setTimeout(tick, 60_000);
  };
  void loadItemConfig();
  void tick();
  void ensureSales();
  setInterval(() => void ensureSales(), 60_000);
}

export function setKey(k: string | null): void {
  const changed = k !== key;
  key = k;
  if (changed && k) void ensureSales();
}

// ------------------------------------------------------------------ Demo

async function demoLoop(gen: number): Promise<void> {
  let seq = 0;
  while (gen === generation) {
    const s = session.value;
    if (!s) return;
    const burst = Math.random() < 0.15 ? 10 + Math.floor(Math.random() * 30) : 1;
    const fresh: Pull[] = [];
    for (let i = 0; i < burst; i++) {
      const caseCode: CaseCode = Math.random() < 0.6 ? 'case2' : 'case1';
      let roll = Math.random();
      let rarity: Rarity = RARITIES[0];
      for (const r of RARITIES) {
        rarity = r;
        if (roll < CASE_ODDS[caseCode][r]) break;
        roll -= CASE_ODDS[caseCode][r];
      }
      const options = codesOf(rarity);
      let pick = Math.random();
      let code = options[0].code;
      for (const o of options) {
        code = o.code;
        if (pick < o.p) break;
        pick -= o.p;
      }
      const ranges = statRangesOf(code) ?? {};
      const skills = Object.fromEntries(Object.entries(ranges).map(([k, [lo, hi]]) => [k, Math.round(lo + Math.random() * (hi - lo))]));
      const id = `demo${Date.now().toString(16)}${(seq++).toString(16).padStart(5, '0')}`;
      fresh.push({
        id,
        itemId: id,
        at: new Date(Date.now() + i).toISOString(),
        caseCode,
        itemCode: code,
        rarity,
        skills,
        cost: market.value.prices[caseCode] ?? null,
      });
    }
    addPulls(fresh);
    status.value = { state: 'live', message: null, lastOkAt: Date.now() };
    await sleep(500 + Math.random() * 900);
  }
}
