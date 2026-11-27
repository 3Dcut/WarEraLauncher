// Ablauf des Kisten-Assistenten: Sitzung starten (Stand merken oder rückwirkend laden), Öffnungen des Spielers laufend
// abfragen, Zerlegungen und Verkäufe den Ziehungen zuordnen, Kisten-, Schrott- und Itemmärkte beobachten. Alles Abgeleitete
// (Empfehlungen, Summen, Glück) rechnet stats.ts.
//
// Die Ziehungen liegen in einem Spaltenspeicher (store.ts), nicht in der Sitzung: 32 Byte je Kiste statt über 580, damit eine
// Million Kisten in rund 35 MB passt. Die Sitzung selbst besteht nur aus Metadaten (localStorage). Die Ziehungen legt
// snapshot.ts verdichtet in IndexedDB ab (rund 2 Byte je Kiste), sobald alles geladen ist und danach gedrosselt; nach einem
// Neuladen kommt der Stand von dort zurück, und das Nachladen holt nur die Lücke. Fehlt der Zwischenspeicher oder passt er nicht
// zur Sitzung, liest das Nachladen den Zeitraum frisch, was dank paralleler Zeitscheiben (loader.ts) schnell genug geht.
//
// Rückwirkende Zeiträume werden nicht abgewartet: Die Sitzung erscheint nach der ersten Seite, der Rest kommt im Hintergrund
// dazu. Neue Ziehungen und Ergebnisse gehen gedrosselt in die Zeitordnung, damit die Oberfläche bei hunderttausenden Kisten
// nicht bei jeder Seite neu rechnet.

import { signal, batch as batchSignals } from '@preact/signals';
import { ApiError, fetchTx, fetchTxUntil, fetchBooks, fetchHistory, fetchPrices, fetchAccountStart, type Book, type TradingDay } from '../assist/api';
import { RateBudget } from '../assist/limiter';
import { fetchSales, fetchAverages, loadItemConfig, rarityOf, statRangesOf } from '../battle/api';
import { RARITIES, type Rarity, type Sale } from '../battle/logic';
import { caseCodes, CASE_ODDS, codesOf, sinceFor, type CaseCode, type Since } from './logic';
import { HistoryLoader, type Pages } from './loader';
import { Intake, type OpenTx } from './intake';
import { PullStore } from './store';
import { encodeSnapshot, decodeSnapshot } from './snapshot';
import { indexedDbBackend, type SnapshotBackend } from './snapshot-db';
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
  /** Öffnungen, die beim Start schon da waren (nur bei „jetzt“). */
  seen: string[];
  live: boolean;
  demo: boolean;
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
  /** Älteste bisher gelesene Öffnung (ISO); mit parallelen Zeitscheiben der älteste Punkt irgendeiner Scheibe. */
  oldest: string | null;
  /** Bisher gefundene Kisten (rot und grün). */
  pulls: number;
  /** Zeitscheiben, die gerade parallel gelesen werden. */
  slices: number;
  /** Die Obergrenze für Öffnungen wurde erreicht, Älteres fehlt teilweise. */
  truncated: boolean;
  message: string | null;
}

const SESSION_KEY = 'wca:session';
/** Obergrenze gelesener Öffnungen je Sitzung: rund 70 MB Speicher bei zwei Millionen. */
export const LOAD_LIMIT = 2_000_000;

const IDLE_LOAD: LoadState = { phase: 'idle', fraction: null, oldest: null, pulls: 0, slices: 0, truncated: false, message: null };

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
/** Zählt bei jedem Veröffentlichen hoch (und bei jeder neuen Sitzung); wer den Speicher liest, hängt sich daran. */
export const storeVersion = signal(0);

/** Zählt bei jedem Anhalten, Fortsetzen und Neustart hoch; laufende Schleifen merken daran, dass sie enden sollen. */
let generation = 0;
/** Zählt nur, wenn eine andere Sitzung beginnt oder endet; Antworten einer alten Sitzung werden verworfen. */
let epoch = 0;
/** Zählt, wenn das Nachladen beendet oder neu gestartet wird. */
let loadGen = 0;
let key: string | null = null;

let store = new PullStore();
let intake = new Intake(store, '');
let loader: HistoryLoader | null = null;
/** Öffnungen, die beim Start schon da waren (nur bei „jetzt“), und die von der Live-Abfrage aufgenommenen. */
let headIds = new Set<string>();
let recent = new Set<string>();
/** Grenze der Live-Abfrage (ISO): was nicht neuer ist, gehört dem Nachladen oder war schon da. */
let liveFloor: string | null = null;
let liveFloorInclusive = false;
/** Live erkannte Ziehungen ohne Kistenpreis (der Markt war noch nicht geladen). */
let needsPrice: number[] = [];
let outcomeWatermark: string | null = null;
let throttle = 0;

// ------------------------------------------------------------------ Zwischenspeicher

const SNAPSHOT_DELAY_MS = 30_000;
let backendOverride: SnapshotBackend | null | undefined;
let backendCache: SnapshotBackend | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotDue = 0;
let snapshotDirty = false;
let snapshotBusy = false;
/** Der Zwischenstand stammt aus einem Laden, das die Obergrenze erreichte. */
let truncatedBefore = false;

/** Ersetzt den Speicher des Zwischenstands (für Tests); null schaltet ihn ab, undefined stellt den Browserspeicher wieder ein. */
export function setSnapshotBackend(b: SnapshotBackend | null | undefined): void {
  backendOverride = b;
}

function backend(): SnapshotBackend | null {
  if (backendOverride !== undefined) return backendOverride;
  return (backendCache ??= indexedDbBackend());
}

/** Plant das Ablegen frühestens in `delay` ms; ein schon geplanter früherer Zeitpunkt bleibt. */
function planSnapshot(delay: number): void {
  if (!backend()) return;
  const due = Date.now() + delay;
  if (snapshotTimer && snapshotDue <= due) return;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotDue = due;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    void saveSnapshot();
  }, delay);
}

function cancelSnapshot(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  snapshotDirty = false;
}

/** Verwirft den abgelegten Stand (neue oder verworfene Sitzung). */
function dropSnapshot(): void {
  const be = backend();
  if (be) void be.remove().catch(() => undefined);
}

/** Zeit (ms), vor der alle Zerlegungen und Verkäufe verarbeitet sind. */
function watermarkMs(s: Session): number {
  if (outcomeWatermark) return Date.parse(outcomeWatermark);
  return s.since ? Date.parse(s.since) : s.startedAt - 60_000;
}

/**
 * Legt den Stand der Sitzung verdichtet ab. Das geschieht nur bei vollständig geladenem Zeitraum (ein halber Stand ließe beim
 * Wiederherstellen Lücken) und nur, wenn sich seit dem letzten Mal etwas geändert hat. Fehler bleiben ohne Folgen.
 */
export async function saveSnapshot(): Promise<void> {
  const s = session.value;
  const be = backend();
  if (!s || s.demo || !be || snapshotBusy || !snapshotDirty) return;
  if (loader && !loader.done) {
    planSnapshot(SNAPSHOT_DELAY_MS);
    return;
  }
  snapshotBusy = true;
  const born = epoch;
  try {
    snapshotDirty = false;
    const bytes = await encodeSnapshot(store, intake, {
      userId: s.userId,
      startedAt: s.startedAt,
      since: s.since,
      outcomesWatermark: watermarkMs(s),
      truncated: truncatedBefore || !!loader?.truncated,
    });
    if (born !== epoch) return;
    if (bytes) await be.put(bytes);
  } catch {
    snapshotDirty = true;
  } finally {
    snapshotBusy = false;
  }
}

/** Liest den abgelegten Stand, wenn er zu dieser Sitzung gehört; sonst null (ein unbrauchbarer Stand wird verworfen). */
async function restoreSnapshot(meta: Session): Promise<Awaited<ReturnType<typeof decodeSnapshot>> | null> {
  const be = backend();
  if (!be) return null;
  let bytes: Uint8Array | null;
  try {
    bytes = await be.get();
  } catch {
    return null;
  }
  if (!bytes) return null;
  try {
    const snap = await decodeSnapshot(bytes);
    const m = snap.meta;
    if (m.userId === meta.userId && m.startedAt === meta.startedAt && m.since === meta.since) return snap;
  } catch {
    /* beschädigt oder aus einer anderen Fassung */
  }
  dropSnapshot();
  return null;
}

/** Der Speicher der laufenden Sitzung (nach jedem Veröffentlichen gilt `storeVersion` als neu). */
export const getStore = (): PullStore => store;

/** Höchstens 360 Anfragen je Minute für das Nachladen; der Rest des Limits von 500 bleibt für Live-Abfrage und Märkte. */
const budget = new RateBudget(360);

function resetRuntime(userId: string): void {
  epoch++;
  loadGen++;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  cancelSnapshot();
  truncatedBefore = false;
  store = new PullStore();
  intake = new Intake(store, userId);
  loader = null;
  headIds = new Set();
  recent = new Set();
  liveFloor = null;
  liveFloorInclusive = false;
  needsPrice = [];
  outcomeWatermark = null;
  loading.value = IDLE_LOAD;
  storeVersion.value++;
}

// ------------------------------------------------------------------ Speichern

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Schreibt die Sitzung (nur Metadaten) in den Browserspeicher. */
function persist(now = false): void {
  if (now) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    writeSession();
  } else if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeSession();
    }, 500);
  }
}

function writeSession(): void {
  try {
    const s = session.value;
    if (!s) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, v: 2 }));
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
    void saveSnapshot();
  });
  // Beim Wechsel in den Hintergrund legt der Browser Seiten oft ohne weiteres Ereignis still: jetzt ablegen
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveSnapshot();
  });
}

// ------------------------------------------------------------------ Veröffentlichen

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastFlush = 0;

/** Pausen zwischen zwei Veröffentlichungen: je größer die Sitzung, desto seltener rechnet die Oberfläche neu. */
function flushGap(n: number): number {
  return n > 500_000 ? 2500 : n > 100_000 ? 1500 : n > 20_000 ? 900 : n > 3_000 ? 450 : 120;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const wait = Math.max(0, lastFlush + flushGap(store.n) - Date.now());
  flushTimer = setTimeout(flush, wait);
}

/** Nimmt alles seit dem letzten Mal in die Zeitordnung auf und meldet der Oberfläche eine neue Version. */
function flush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  store.publish();
  lastFlush = Date.now();
  storeVersion.value++;
  snapshotDirty = true;
  planSnapshot(SNAPSHOT_DELAY_MS);
}

// ------------------------------------------------------------------ Aufnahme

/** Seiten aus dem Nachladen in den Speicher übernehmen. Nachgeladene Ziehungen tragen keinen Kistenpreis (siehe PullStore.cost). */
function ingest(pages: Pages): void {
  for (const tx of pages.open) intake.addOpen(tx, NaN);
  intake.addScraps(pages.scrap);
  intake.addSales(pages.sale);
  void ensureSales();
  scheduleFlush();
}

/**
 * Legt fest, ab wann die Live-Abfrage etwas als neu ansieht: Alles, was nicht jünger ist als die neueste bisher gelesene
 * Öffnung, gehört dem Nachladen. Das schützt vor Doppelten, auch wenn die Live-Abfrage erst nach dem ersten Lesen oder nach
 * einer Pause (Neuladen, Fortsetzen) anläuft.
 */
function armLive(): void {
  const newest = loader?.state.open.newest ?? null;
  if (newest) {
    liveFloor = newest;
    liveFloorInclusive = true;
  }
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

function makeLoader(userId: string, since: string | null, startedAt: number, planFrom: number | null): HistoryLoader {
  return new HistoryLoader({
    userId,
    since,
    startedAt,
    planFrom,
    maxOpen: LOAD_LIMIT,
    fetch: (queries) => fetchTx(queries, key!),
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
        const [page] = await fetchTx<OpenTx>([{ userId: opts.userId, types: ['openCase'], limit: 25 }], opts.key!);
        const sorted = [...page.items].filter((tx) => tx.createdAt).sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : 1));
        since = sorted.length ? sorted[sorted.length - 1].createdAt! : null;
        seen = sorted.map((tx) => tx._id!).filter(Boolean);
      } else {
        since = sinceFor(range, startedAt, opts.date);
        if (range === 'date' && since === null) throw new ApiError('date', -1);
        // Bei „alles“ gibt der Anfang der Aufzeichnung die Untergrenze für die Planung paralleler Zeitscheiben
        const planFrom = since === null ? await fetchAccountStart(opts.userId, opts.key) : null;
        // Die erste Seite kommt sofort, damit die Sitzung nicht leer erscheint; der Rest läuft im Hintergrund
        fresh = makeLoader(opts.userId, since, startedAt, planFrom);
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
  // Eine neue Sitzung ersetzt den Zwischenstand der alten
  dropSnapshot();
  session.value = { userId: opts.userId, name: opts.name, startedAt, since, range, seen, live: true, demo: !!opts.demo };
  for (const id of seen) headIds.add(id);
  status.value = { state: 'live', message: null, lastOkAt: Date.now() };
  if (first && fresh) {
    // Das Nachladen deckt alles bis zum Start ab; danach schauen nur noch die Ergebnisabfragen nach
    outcomeWatermark = new Date(startedAt - 60_000).toISOString();
    liveFloor = since;
    ingest(first);
    armLive();
    flush();
    // Passt der ganze Zeitraum schon in die erste Anfrage (wenige oder gar keine Kisten), ist das Nachladen damit fertig
    publishLoad(fresh, fresh.done ? 'done' : 'loading');
    if (fresh.done) planSnapshot(1500);
  } else {
    liveFloor = since;
  }
  persist(true);
  void ensureSales();
  if (opts.demo) void demoLoop(gen);
  else startLoops(gen);
}

/** Setzt eine gespeicherte Sitzung nach dem Neuladen fort; die Ziehungen werden dabei frisch gelesen. */
export function resumeSession(k: string | null): boolean {
  let stored: (Session & { v?: number }) | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored?.userId || typeof stored.startedAt !== 'number') return false;
  key = k;
  const gen = ++generation;
  resetRuntime(stored.userId);
  const meta: Session = {
    userId: stored.userId,
    name: stored.name ?? '',
    startedAt: stored.startedAt,
    since: stored.since ?? null,
    range: stored.range,
    seen: Array.isArray(stored.seen) ? stored.seen : [],
    live: !!stored.live,
    demo: !!stored.demo,
  };
  session.value = meta;
  for (const id of meta.seen) headIds.add(id);
  liveFloor = meta.since;
  void ensureSales();
  if (meta.demo) {
    if (meta.live) {
      status.value = { state: 'live', message: null, lastOkAt: 0 };
      void demoLoop(gen);
    }
    return true;
  }
  if (!k) {
    // Ohne Schlüssel lässt sich nichts nachladen; der Zwischenspeicher zeigt wenigstens den letzten Stand
    if (meta.live) patch({ live: false });
    void bootResumed(gen, meta, false);
    return true;
  }
  loading.value = { ...IDLE_LOAD, phase: 'loading' };
  if (meta.live) status.value = { state: 'live', message: null, lastOkAt: 0 };
  void bootResumed(gen, meta, true);
  return true;
}

/**
 * Nach dem Neuladen: erst den Zwischenspeicher versuchen, dann Live-Abfrage und Nachladen starten. Gibt es ihn, kommt der Stand
 * sofort zurück und das Nachladen holt nur die Lücke (Öffnungen ab dem Stand, Ergebnisse ab dem letzten Abgleich). Sonst wird
 * der Zeitraum frisch gelesen. Die Live-Abfrage läuft nur, wenn die Sitzung live war.
 */
async function bootResumed(gen: number, meta: Session, canLoad: boolean): Promise<void> {
  const born = epoch;
  const snap = await restoreSnapshot(meta);
  if (born !== epoch) return;
  const startedAt = Date.now();
  if (snap) {
    const m = snap.meta;
    store = snap.store;
    intake = snap.intake;
    truncatedBefore = m.truncated;
    needsPrice = [];
    outcomeWatermark = new Date(m.outcomesFrom).toISOString();
    // Was vor `boundary` liegt, hat der Zwischenspeicher; die Live-Abfrage darf es nicht noch einmal aufnehmen
    liveFloor = new Date(m.boundary).toISOString();
    liveFloorInclusive = false;
    if (canLoad) {
      loader = new HistoryLoader({
        userId: meta.userId,
        since: meta.since,
        lower: { open: new Date(m.boundary).toISOString(), scrap: outcomeWatermark, sale: outcomeWatermark },
        floorOutcomes: false,
        startedAt,
        maxOpen: Math.max(1, LOAD_LIMIT - store.n),
        fetch: (queries) => fetchTx(queries, key!),
      });
    }
    flush();
    snapshotDirty = false;
    void ensureSales();
    if (loader) publishLoad(loader);
    else loading.value = { ...IDLE_LOAD, phase: 'done', fraction: 1, pulls: store.n, truncated: truncatedBefore, oldest: store.span() ? new Date(store.span()!.first).toISOString() : null };
  } else if (canLoad) {
    // Der Zeitraum wird neu gelesen
    loader = makeLoader(meta.userId, lowerBound(meta), startedAt, null);
    outcomeWatermark = new Date(startedAt - 60_000).toISOString();
  }
  if (canLoad && gen === generation) startLoops(gen);
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
  void saveSnapshot();
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
  dropSnapshot();
  session.value = null;
  persist(true);
  status.value = { state: 'idle', message: null, lastOkAt: 0 };
}

/**
 * Startet Live-Abfrage und Ergebnisabfrage; ein noch unfertiges Nachladen läuft daneben. Ist die Sitzung angehalten, läuft nur
 * das Nachladen (nach einem Neuladen sind ja die Ziehungen weg).
 */
function startLoops(gen: number): void {
  const l = loader;
  const live = !!session.value?.live;
  const pending = !!l && !l.done;
  // Wurde noch keine Seite gelesen (nach dem Neuladen), kommt die Live-Abfrage erst danach: sonst blättert sie
  // durch die ganze Vergangenheit, die das Nachladen ohnehin gleich holt
  const gated = pending && l!.requests === 0;
  if (pending) void backfillLoop(gen, gated && live);
  if (live && !gated) {
    armLive();
    void pollLoop(gen);
    void outcomeLoop(gen);
  }
}

// ------------------------------------------------------------------ Nachladen

function publishLoad(l: HistoryLoader, phase: LoadState['phase'] = 'loading', message: string | null = null): void {
  // Nach einer Wiederherstellung kennt der Loader nur die Lücke; der älteste Punkt steht im Speicher
  const span = store.span();
  const oldest = span ? new Date(span.first).toISOString() : l.oldestOpen;
  loading.value = { phase, fraction: l.progress(), oldest, pulls: store.n, slices: l.active, truncated: l.truncated || truncatedBefore, message };
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
        armLive();
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
    planSnapshot(1500);
  }
}

/** Eine Anfrage mit mehreren Scheiben; bei Fehlern mit wachsenden Pausen wiederholen. Der Loader behält dabei seinen Stand. */
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

/** Erkennt, was die Live-Abfrage schon kennt oder nicht mehr anfassen darf. */
function isOld(tx: OpenTx): boolean {
  if (!tx._id || !tx.createdAt) return true;
  if (headIds.has(tx._id) || recent.has(tx._id)) return true;
  if (liveFloor === null) return false;
  return liveFloorInclusive ? tx.createdAt <= liveFloor : tx.createdAt < liveFloor;
}

async function pollOnce(gen: number): Promise<void> {
  const s = session.value;
  if (!s || !key) return;
  try {
    const [page] = await fetchTx<OpenTx>([{ userId: s.userId, types: ['openCase'], limit: 25 }], key);
    if (gen !== generation) return;
    let items = page.items.filter((tx) => !isOld(tx));
    // Ganze Seite neu (etwa "Alle öffnen"): weiter zurückblättern, bis Bekanntes auftaucht
    if (items.length === page.items.length && page.nextCursor && items.length) {
      const more = await fetchTxUntil<OpenTx>({ userId: s.userId, types: ['openCase'], limit: 100, cursor: page.nextCursor }, key, isOld, 60);
      if (gen !== generation) return;
      items = [...items, ...more.items];
    }
    let added = 0;
    for (const tx of items) {
      const slot = intake.addOpen(tx, priceOf(tx.itemCode));
      // Andere Kisten (Holzkiste, Werkzeugkasten) nur als gesehen merken
      if (tx._id) recent.add(tx._id);
      if (slot >= 0) {
        added++;
        if (Number.isNaN(store.cost[slot])) needsPrice.push(slot);
      }
    }
    if (recent.size > 100_000) {
      let drop = 50_000;
      for (const id of recent) {
        if (drop-- <= 0) break;
        recent.delete(id);
      }
    }
    if (added) {
      void ensureSales();
      scheduleFlush();
    }
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

/** Marktpreis einer Kiste von jetzt, NaN solange die Preise nicht geladen sind. */
function priceOf(code: string | undefined): number {
  return (code && market.value.prices[code]) || NaN;
}

// ------------------------------------------------------------------ Zerlegt oder verkauft?

const OUTCOME_MS = 12_000;
let sweeping = false;

async function outcomeLoop(gen: number): Promise<void> {
  await sleep(2000);
  while (gen === generation) {
    const s = session.value;
    // Ohne offene Ziehung gibt es nichts zuzuordnen
    if (s && key && intake.open > 0) await outcomeSweep(gen, outcomeWatermark ?? lowerBound(s));
    await sleep(OUTCOME_MS * 2 ** throttle);
  }
}

/** Einmal nachsehen, etwa in einer angehaltenen Sitzung: liest Zerlegungen und Verkäufe seit dem letzten Stand. */
export async function refreshOutcomes(): Promise<void> {
  const s = session.value;
  if (!key || !s) return;
  await outcomeSweep(generation, outcomeWatermark ?? lowerBound(s));
}

/**
 * Liest Zerlegungen und Verkäufe von neu bis zur Grenze `floor` und ordnet sie zu. Meist ist das eine einzige Anfrage, weil die
 * Grenze nur wenige Minuten zurückliegt; nach langer Pause sind es entsprechend mehr. Verkäufe können Tage nach der Öffnung
 * eintreffen, deshalb bleiben offene Ziehungen dauerhaft im Blick.
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
      fetch: (queries) => fetchTx(queries, key!),
    });
    while (!sweeper.done && gen === generation) {
      await budget.take();
      const pages = await sweeper.step();
      if (born !== epoch) return;
      intake.addScraps(pages.scrap);
      intake.addSales(pages.sale);
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
    const wanted = [...new Set([...caseCodes('case2'), ...caseCodes('case1'), ...store.dict.codes])];
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
      // Kistenpreis für Ziehungen nachtragen, die live ohne Preis erkannt wurden. Nachgeladene ältere Ziehungen behalten NaN:
      // sie werden mit dem Tagesmittel ihres Tages bewertet, nicht mit dem Preis von jetzt.
      if (needsPrice.length) {
        const rest: number[] = [];
        for (const slot of needsPrice) {
          const price = prices[store.kase[slot] === 1 ? 'case2' : 'case1'];
          if (price) store.cost[slot] = price;
          else rest.push(slot);
        }
        needsPrice = rest;
        scheduleFlush();
      }
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
    let added = 0;
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
      const at = new Date(Date.now() + i).toISOString();
      const tx: OpenTx = {
        _id: id,
        transactionType: 'openCase',
        itemCode: caseCode,
        buyerId: s.userId,
        sellerId: s.userId,
        createdAt: at,
        item: { _id: `${id}i`, code, skills, lastAcquisitionAt: at },
      };
      if (intake.addOpen(tx, priceOf(caseCode)) >= 0) added++;
    }
    if (added) {
      void ensureSales();
      scheduleFlush();
    }
    status.value = { state: 'live', message: null, lastOkAt: Date.now() };
    await sleep(500 + Math.random() * 900);
  }
}
