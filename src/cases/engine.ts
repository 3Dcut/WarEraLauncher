// Ablauf des Kisten-Assistenten: Sitzung starten (Stand merken oder rückwirkend laden), Öffnungen
// des Spielers laufend abfragen, Zerlegungen und Verkäufe den Ziehungen zuordnen, Kisten-, Schrott-
// und Itemmärkte beobachten. Alles Abgeleitete (Empfehlungen, Summen, Glück) rechnet stats.ts.
//
// Rückwirkende Zeiträume werden nicht abgewartet: Die Sitzung erscheint nach der ersten Seite, der Rest
// kommt im Hintergrund (loader.ts) Seite für Seite von neu nach alt dazu. Neue Ziehungen und Ergebnisse
// sammeln sich in einem Puffer und gehen gedrosselt in die Sitzung, damit die Oberfläche bei zehntausenden
// Kisten nicht bei jeder Seite neu rechnet.

import { signal, batch as batchSignals } from '@preact/signals';
import { ApiError, fetchTx, fetchTxUntil, fetchBooks, fetchHistory, fetchPrices, type Book, type TradingDay } from '../assist/api';
import { RateBudget } from '../assist/limiter';
import { fetchSales, fetchAverages, loadItemConfig, rarityOf, statRangesOf } from '../battle/api';
import { RARITIES, type Rarity, type RawTransaction, type Sale } from '../battle/logic';
import { byTime, caseCodes, CASE_ODDS, codesOf, mergeSorted, sinceFor, toPull, type CaseCode, type Outcome, type Pull, type Since } from './logic';
import { HistoryLoader, type Pages } from './loader';
import { OutcomeMatcher, type Found } from './outcomes';
import { t } from '../i18n';

export type { Since } from './logic';

export interface Session {
  userId: string;
  name: string;
  startedAt: number;
  /** Serverzeit (ISO), ab der Öffnungen zählen; null: ohne Untergrenze. */
  since: string | null;
  /** Zeitraum, mit dem die Sitzung gestartet wurde (für die Anzeige). */
  range?: Since;
  /** Öffnungen, die beim Start schon da waren. */
  seen: string[];
  pulls: Pull[];
  outcomes: Record<string, Outcome>;
  live: boolean;
  demo: boolean;
  /**
   * Nur in der gespeicherten Fassung: Ziehungen fehlen oder sind unvollständig (zu viele für den Browserspeicher,
   * oder das Nachladen war noch nicht fertig). Beim Fortsetzen wird der Zeitraum neu geladen.
   */
  partial?: boolean;
}

export interface Market {
  prices: Record<string, number>;
  books: Record<string, Book>;
  history: Record<string, TradingDay[]>;
  at: number;
}

/** Wie weit das Nachladen eines rückwirkenden Zeitraums ist. */
export interface LoadState {
  /** idle: nichts zu laden; loading: läuft; stopped: vom Nutzer beendet; done: vollständig; error: Abbruch nach Fehlern. */
  phase: 'idle' | 'loading' | 'stopped' | 'done' | 'error';
  /** Anteil des Zeitraums (0 bis 1); null ohne Untergrenze. */
  fraction: number | null;
  /** Älteste bisher gelesene Öffnung (ISO). */
  oldest: string | null;
  /** Bisher gefundene Kisten (rot und grün). */
  pulls: number;
  /** Die Obergrenze für Öffnungen wurde erreicht, Älteres fehlt. */
  truncated: boolean;
  message: string | null;
}

const SESSION_KEY = 'wca:session';
/** Größere Sitzungen passen nicht in den Browserspeicher (etwa fünf MB); sie werden beim Fortsetzen neu geladen. */
const PERSIST_MAX_PULLS = 3000;
/** Obergrenze gelesener Öffnungen je Sitzung (Speicher des Browsers). */
export const LOAD_LIMIT = 250_000;

const IDLE_LOAD: LoadState = { phase: 'idle', fraction: null, oldest: null, pulls: 0, truncated: false, message: null };

export const session = signal<Session | null>(null);
export const loading = signal<LoadState>(IDLE_LOAD);
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

/** Zählt bei jedem Anhalten, Fortsetzen und Neustart hoch; laufende Schleifen merken daran, dass sie enden sollen. */
let generation = 0;
/** Zählt nur, wenn eine andere Sitzung beginnt oder endet; Antworten einer alten Sitzung werden verworfen. */
let epoch = 0;
/** Zählt, wenn das Nachladen beendet oder neu gestartet wird. */
let loadGen = 0;
let key: string | null = null;

let loader: HistoryLoader | null = null;
let matcher = new OutcomeMatcher('');
/** IDs aller Öffnungen, die die Sitzung kennt (Ziehungen und Nicht-Kisten). */
let knownIds = new Set<string>();
/** Itemcodes der bisherigen Ziehungen (für die Verkaufsabfragen). */
let codeSet = new Set<string>();
let pullCount = 0;
let outcomeWatermark: string | null = null;
let throttle = 0;

/** Höchstens 360 Anfragen je Minute für das Nachladen; der Rest des Limits von 500 bleibt für Live-Abfrage und Märkte. */
const budget = new RateBudget(360);

interface Buffer {
  pulls: Pull[];
  outcomes: Record<string, Outcome>;
  outcomeCount: number;
  seen: string[];
}
const emptyBuffer = (): Buffer => ({ pulls: [], outcomes: {}, outcomeCount: 0, seen: [] });
let buffer = emptyBuffer();

function resetRuntime(userId: string): void {
  epoch++;
  loadGen++;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  matcher = new OutcomeMatcher(userId);
  knownIds = new Set();
  codeSet = new Set();
  buffer = emptyBuffer();
  loader = null;
  pullCount = 0;
  outcomeWatermark = null;
  loading.value = IDLE_LOAD;
}

// ------------------------------------------------------------------ Speichern

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Schreibt die Sitzung in den Browserspeicher; gedrosselt, weil bei großen Sitzungen jedes Schreiben spürbar kostet. */
function persist(now = false): void {
  if (now) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    writeSession();
  } else if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeSession();
    }, 1000);
  }
}

function writeSession(): void {
  try {
    const s = session.value;
    if (!s) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    const unfinished = !!loader && !loader.done && !s.demo;
    const stored: Session =
      s.pulls.length > PERSIST_MAX_PULLS
        ? { ...s, pulls: [], outcomes: {}, seen: [], partial: true }
        : unfinished
          ? { ...s, partial: true }
          : { ...s, partial: undefined };
    localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
  } catch {
    /* Speicher voll oder gesperrt */
  }
}

function patch(p: Partial<Session>): void {
  if (!session.value) return;
  session.value = { ...session.value, ...p };
  persist();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    flush();
    persist(true);
  });
}

// ------------------------------------------------------------------ Puffer

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastFlush = 0;

/** Pausen zwischen zwei Veröffentlichungen: je größer die Sitzung, desto seltener rechnet die Oberfläche neu. */
function flushGap(n: number): number {
  return n > 20_000 ? 900 : n > 3_000 ? 450 : 120;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const wait = Math.max(0, lastFlush + flushGap(session.value?.pulls.length ?? 0) - Date.now());
  flushTimer = setTimeout(flush, wait);
}

/** Übernimmt alles Gepufferte in die Sitzung. */
function flush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const s = session.value;
  const b = buffer;
  if (!s || (!b.pulls.length && !b.outcomeCount && !b.seen.length)) return;
  buffer = emptyBuffer();
  lastFlush = Date.now();
  // Die Ergebnisse werden in das vorhandene Objekt geschrieben statt kopiert: bei 100.000 Einträgen kostete das Kopieren
  // bei jeder Veröffentlichung gut 40 ms. Die Sitzung bekommt trotzdem ein neues Objekt, daran erkennt die Oberfläche die Änderung.
  if (b.outcomeCount) Object.assign(s.outcomes, b.outcomes);
  batchSignals(() => {
    session.value = {
      ...s,
      pulls: b.pulls.length ? mergeSorted(s.pulls, b.pulls.sort(byTime), byTime) : s.pulls,
      seen: b.seen.length ? [...s.seen, ...b.seen] : s.seen,
    };
  });
  persist();
}

function collect(found: Found): void {
  for (const id in found) {
    buffer.outcomes[id] = found[id];
    buffer.outcomeCount++;
  }
}

function markSeen(ids: string[]): void {
  for (const id of ids) {
    if (knownIds.has(id)) continue;
    knownIds.add(id);
    buffer.seen.push(id);
  }
  if (buffer.seen.length) scheduleFlush();
}

/** Nimmt neue Ziehungen auf (gleiche ID zählt nur einmal) und ordnet vorhandene Ergebnisse zu. */
function addPulls(fresh: Pull[]): void {
  if (!session.value || !fresh.length) return;
  const add: Pull[] = [];
  for (const p of fresh) {
    if (knownIds.has(p.id)) continue;
    knownIds.add(p.id);
    codeSet.add(p.itemCode);
    add.push(p);
  }
  if (!add.length) return;
  pullCount += add.length;
  for (const p of add) buffer.pulls.push(p);
  collect(matcher.addPulls(add));
  scheduleFlush();
  void ensureSales();
}

/** Seiten aus dem Nachladen in die Sitzung übernehmen. Nachgeladene Ziehungen tragen keinen Kistenpreis (siehe Pull.cost). */
function ingest(pages: Pages): void {
  const s = session.value;
  if (!s) return;
  const fresh: Pull[] = [];
  for (const tx of pages.open) {
    const p = toPull(tx, s.userId, rarityOf);
    if (p) fresh.push({ ...p, cost: null });
  }
  addPulls(fresh);
  collect(matcher.addScraps(pages.scrap));
  collect(matcher.addSales(pages.sale));
  scheduleFlush();
}

// ------------------------------------------------------------------ Fehler

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
  /** Datum (JJJJ-MM-TT) bei since = 'date'. */
  date?: string | null;
  key: string | null;
  demo?: boolean;
}

function makeLoader(userId: string, since: string | null, startedAt: number): HistoryLoader {
  return new HistoryLoader({
    userId,
    since,
    startedAt,
    maxOpen: LOAD_LIMIT,
    fetch: (queries) => fetchTx<RawTransaction>(queries, key!),
  });
}

export async function startSession(opts: StartOptions): Promise<void> {
  const gen = ++generation;
  key = opts.key;
  keyRejected.value = false;
  status.value = { state: 'arming', message: null, lastOkAt: 0 };
  resetRuntime(opts.userId);
  const mine = epoch;
  const range: Since = opts.demo ? 'now' : opts.since;
  const startedAt = Date.now();
  let since: string | null = null;
  let seen: string[] = [];
  let first: Pages | null = null;
  let fresh: HistoryLoader | null = null;
  if (!opts.demo) {
    try {
      if (range === 'now') {
        const [page] = await fetchTx<RawTransaction>([{ userId: opts.userId, types: ['openCase'], limit: 25 }], opts.key!);
        const sorted = [...page.items].filter((tx) => tx.createdAt).sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : 1));
        since = sorted.length ? sorted[sorted.length - 1].createdAt! : null;
        seen = sorted.map((tx) => tx._id!).filter(Boolean);
      } else {
        since = sinceFor(range, startedAt, opts.date);
        if (range === 'date' && since === null) throw new ApiError('date', -1);
        // Die erste Seite kommt sofort, damit die Sitzung nicht leer erscheint; der Rest läuft im Hintergrund
        fresh = makeLoader(opts.userId, since, startedAt);
        first = await fresh.step();
      }
    } catch (err) {
      if (gen !== generation) return;
      const noDate = err instanceof ApiError && err.status === -1;
      status.value = { state: 'error', message: noDate ? t('cases.err.noDate') : describe(err), lastOkAt: 0 };
      keyRejected.value = isKeyError(err);
      return;
    }
  }
  if (gen !== generation || mine !== epoch) return;
  loader = fresh;
  session.value = { userId: opts.userId, name: opts.name, startedAt, since, range, seen, pulls: [], outcomes: {}, live: true, demo: !!opts.demo };
  for (const id of seen) knownIds.add(id);
  status.value = { state: 'live', message: null, lastOkAt: Date.now() };
  if (first && fresh) {
    // Das Nachladen deckt alles bis zum Start ab; danach schauen nur noch die Ergebnisabfragen nach
    outcomeWatermark = new Date(startedAt - 60_000).toISOString();
    ingest(first);
    flush();
    publishLoad(fresh);
  }
  persist(true);
  void ensureSales();
  if (opts.demo) void demoLoop(gen);
  else startLoops(gen);
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
  resetRuntime(stored.userId);
  const pulls = stored.pulls;
  const outcomes = stored.outcomes ?? {};
  session.value = { ...stored, outcomes, partial: undefined };
  for (const id of stored.seen ?? []) knownIds.add(id);
  for (const p of pulls) {
    knownIds.add(p.id);
    codeSet.add(p.itemCode);
  }
  pullCount = pulls.length;
  matcher.addPulls(pulls, outcomes);
  if (stored.partial && !stored.demo) {
    // Es fehlt etwas: den Zeitraum neu laden, bereits Gespeichertes zählt dabei nicht doppelt
    const startedAt = Date.now();
    loader = makeLoader(stored.userId, lowerBound(stored), startedAt);
    outcomeWatermark = new Date(startedAt - 60_000).toISOString();
    loading.value = { ...IDLE_LOAD, phase: 'loading', pulls: pullCount };
  }
  void ensureSales();
  if (stored.live && (stored.demo || k)) {
    status.value = { state: 'live', message: null, lastOkAt: 0 };
    if (stored.demo) void demoLoop(gen);
    else startLoops(gen);
  } else if (stored.live) {
    patch({ live: false });
  }
  return true;
}

/** Untergrenze für Abfragen dieser Sitzung; „alles“ hat keine, „jetzt“ ohne Vorlauf beginnt mit dem Start. */
function lowerBound(s: Session): string | null {
  if (s.since) return s.since;
  return s.range === 'all' ? null : new Date(s.startedAt - 60_000).toISOString();
}

/** Hält die Live-Abfrage und das Nachladen an; die Auswertung bleibt stehen. */
export function stopSession(): void {
  generation++;
  flush();
  patch({ live: false });
  persist(true);
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
  else startLoops(gen);
}

export function clearSession(): void {
  generation++;
  resetRuntime('');
  session.value = null;
  persist(true);
  status.value = { state: 'idle', message: null, lastOkAt: 0 };
}

/** Startet Live-Abfrage und Ergebnisabfrage; ein noch unfertiges Nachladen läuft daneben. */
function startLoops(gen: number): void {
  const l = loader;
  const pending = !!l && !l.done;
  // Wurde noch keine Seite gelesen (nach dem Neuladen), kommt die Live-Abfrage erst danach: sonst blättert sie
  // durch die ganze Vergangenheit, die das Nachladen ohnehin gleich holt
  const gated = pending && l!.requests === 0;
  if (pending) void backfillLoop(gen, gated);
  if (!gated) {
    void pollLoop(gen);
    void outcomeLoop(gen);
  }
}

// ------------------------------------------------------------------ Nachladen

function publishLoad(l: HistoryLoader, phase: LoadState['phase'] = 'loading', message: string | null = null): void {
  loading.value = { phase, fraction: l.progress(), oldest: l.oldestOpen, pulls: pullCount, truncated: l.truncated, message };
}

/** Beendet das Nachladen, behält aber alles bisher Geladene und die Live-Abfrage. */
export function stopLoading(): void {
  loadGen++;
  flush();
  if (loader && !loader.done) loading.value = { ...loading.value, phase: 'stopped' };
}

/** Setzt ein beendetes oder gescheitertes Nachladen dort fort, wo es aufgehört hat. */
export function continueLoading(): void {
  if (!loader || loader.done || !session.value) return;
  void backfillLoop(generation, false);
}

async function backfillLoop(gen: number, gated: boolean): Promise<void> {
  const l = loader;
  if (!l) return;
  const mine = ++loadGen;
  const born = epoch;
  const alive = () => gen === generation && mine === loadGen;
  loading.value = { ...loading.value, phase: 'loading', message: null };
  let first = gated;
  while (alive() && !l.done) {
    const pages = await stepWithRetry(l, alive);
    if (born !== epoch) return;
    if (pages) {
      // Eine Seite, die beim Beenden schon unterwegs war, wird noch übernommen; der Zustand bleibt dann „beendet“
      ingest(pages);
      publishLoad(l, alive() ? 'loading' : loading.value.phase);
    }
    if (first) {
      first = false;
      if (alive()) {
        void pollLoop(gen);
        void outcomeLoop(gen);
      }
    }
    if (!pages) break;
    await sleep(0);
  }
  if (born !== epoch) return;
  flush();
  if (l.done) {
    publishLoad(l, 'done');
    persist();
  }
}

/** Eine Seite holen; bei Fehlern mit wachsenden Pausen wiederholen. Der Loader behält dabei seinen Stand. */
async function stepWithRetry(l: HistoryLoader, alive: () => boolean): Promise<Pages | null> {
  for (let attempt = 0; ; attempt++) {
    if (!alive()) return null;
    await budget.take();
    if (!alive()) return null;
    try {
      return await l.step();
    } catch (err) {
      if (!alive()) return null;
      if (isKeyError(err)) {
        generation++;
        keyRejected.value = true;
        patch({ live: false });
        loading.value = { ...loading.value, phase: 'error', message: describe(err) };
        status.value = { state: 'error', message: describe(err), lastOkAt: status.value.lastOkAt };
        return null;
      }
      const limited = err instanceof ApiError && err.status === 429;
      if (!limited && attempt >= 5) {
        loading.value = { ...loading.value, phase: 'error', message: describe(err) };
        return null;
      }
      status.value = { ...status.value, state: limited ? 'throttled' : 'stale', message: describe(err) };
      await sleep(limited ? Math.min(30_000, 4_000 * 2 ** Math.min(3, attempt)) : 1_500 * 2 ** attempt);
    }
  }
}

// ------------------------------------------------------------------ Öffnungen

const POLL_MS = 1500;

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
    const isOld = (tx: RawTransaction) => !tx._id || knownIds.has(tx._id) || (!!s.since && !!tx.createdAt && tx.createdAt < s.since);
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
    const taken = new Set(fresh.map((p) => p.id));
    markSeen(items.filter((tx) => tx._id && !taken.has(tx._id)).map((tx) => tx._id!));
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
let sweeping = false;

async function outcomeLoop(gen: number): Promise<void> {
  await sleep(2000);
  while (gen === generation) {
    const s = session.value;
    // Ohne offene Ziehung gibt es nichts zuzuordnen
    if (s && key && matcher.open > 0) await outcomeSweep(gen, outcomeWatermark ?? lowerBound(s));
    await sleep(OUTCOME_MS * 2 ** throttle);
  }
}

/** Einmal abfragen, etwa nach dem Neuladen einer beendeten Sitzung; liest Zerlegungen und Verkäufe ab Sitzungsbeginn neu. */
export async function refreshOutcomes(): Promise<void> {
  const s = session.value;
  if (!key || !s) return;
  await outcomeSweep(generation, lowerBound(s));
}

/**
 * Liest Zerlegungen und Verkäufe von neu bis zur Grenze `floor` und ordnet sie zu. Meist ist das eine einzige Anfrage,
 * weil die Grenze nur wenige Minuten zurückliegt; nach langer Pause oder bei „Neu abgleichen“ sind es entsprechend mehr.
 * Verkäufe können Tage nach der Öffnung eintreffen, deshalb bleiben offene Ziehungen dauerhaft im Blick.
 */
async function outcomeSweep(gen: number, floor: string | null): Promise<void> {
  const s = session.value;
  if (!s || !key || sweeping) return;
  const born = epoch;
  sweeping = true;
  try {
    const sweeper = new HistoryLoader({
      userId: s.userId,
      since: floor,
      streams: ['scrap', 'sale'],
      fetch: (queries) => fetchTx<RawTransaction>(queries, key!),
    });
    while (!sweeper.done && gen === generation) {
      await budget.take();
      const pages = await sweeper.step();
      if (born !== epoch) return;
      collect(matcher.addScraps(pages.scrap));
      collect(matcher.addSales(pages.sale));
      scheduleFlush();
    }
    if (sweeper.done && born === epoch && sweeper.newestOutcome) {
      // Nächstes Mal nur noch die letzte Minute davor nachsehen
      const next = new Date(Date.parse(sweeper.newestOutcome) - 60_000).toISOString();
      if (!outcomeWatermark || next > outcomeWatermark) outcomeWatermark = next;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) throttle = Math.min(3, throttle + 1);
  } finally {
    sweeping = false;
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
    const wanted = [...new Set([...caseCodes('case2'), ...caseCodes('case1'), ...codeSet])];
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
      // Kistenpreis für Ziehungen nachtragen, die live ohne Preis erkannt wurden. Nachgeladene ältere Ziehungen
      // behalten null: sie werden mit dem Tagesmittel ihres Tages bewertet, nicht mit dem Preis von jetzt.
      const s = session.value;
      const recent = Date.now() - 15 * 60_000;
      const needsPrice = (p: Pull) => p.cost === null && Date.parse(p.at) > recent;
      if (s && s.pulls.some(needsPrice)) patch({ pulls: s.pulls.map((p) => (needsPrice(p) ? { ...p, cost: prices[p.caseCode] ?? null } : p)) });
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
