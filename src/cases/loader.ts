// Liest die Transaktionen eines Spielers von neu nach alt, bis zu einer Zeitgrenze, und zwar in Zeitscheiben parallel.
// Drei Ströme laufen nebeneinander: Öffnungen (openCase), Zerlegungen (dismantleItem) und Verkäufe (itemMarket). Je
// Schritt geht eine einzige gebündelte Anfrage hinaus, die für jede Scheibe eine Seite holt; das zählt gegen das Limit
// der API nur einmal (siehe assist/limiter.ts).
//
// Warum Scheiben: Eine Seite hat höchstens 100 Einträge, und der Cursor führt nur von einer Seite zur nächsten. Eine
// Million Kisten wären über 10.000 Anfragen nacheinander, mindestens 28 Minuten allein durch das Limit von 360 je Minute.
// Der Cursor ist aber ein Schlüssel aus Zeit und ID ("v2." + Base64 von [{"t":"date","v":ISO},{"t":"str","v":ID}], so
// ausgelesen am 2026-11-27), und die API lässt sich mit einem selbst gebauten Cursor an jeder Stelle der Zeit aufsetzen.
// Geprüft an 3Dsus: (Zeit, 000…) liefert genau die Einträge strikt vor dieser Zeit, (Zeit, fff…) schließt die Einträge
// derselben Zeit ein, und ein aus dem letzten Eintrag einer Seite gebauter Cursor ist identisch mit dem echten nextCursor.
// Acht Scheiben mit Grenzen mitten in 50er-Bursts ergaben genau die 11.653 Einträge der Referenz, ohne Duplikate.
// Ein Bündel verträgt höchstens 32 Aufrufe (ab 48 antwortet der Server mit HTTP 431, die Adresse wird zu lang).
//
// Jede Scheibe nimmt nur Einträge aus ihrem eigenen Zeitfenster [lo, hi) an. Selbst wenn der Server einen gebauten Cursor
// künftig anders auslegte, entstünden dadurch keine Duplikate; lehnt er ihn ab, fällt der Loader auf sequentielles Lesen
// zurück. Die Arbeit verteilt sich von selbst: Wird eine Scheibe fertig, teilt der Loader die mit der größten geschätzten
// Restmenge in der Mitte ihrer Restspanne.
//
// Der Loader ändert seinen Stand erst, wenn eine Anfrage gelungen ist. Wirft `fetch`, bleibt alles, wie es war, und der
// nächste Schritt fragt dieselben Seiten noch einmal an.

import type { TxPage, TxQuery, TxType } from '../assist/api';
import type { OpenTx, SaleTx, ScrapTx } from './intake';

export type StreamKey = 'open' | 'scrap' | 'sale';
export const STREAMS: StreamKey[] = ['open', 'scrap', 'sale'];

const TYPE: Record<StreamKey, TxType> = { open: 'openCase', scrap: 'dismantleItem', sale: 'itemMarket' };

/** Der Loader braucht von einer Transaktion nur den Zeitpunkt; den Rest reicht er unverändert weiter. */
type Stamped = { createdAt?: string };

export interface Pages {
  open: OpenTx[];
  scrap: ScrapTx[];
  sale: SaleTx[];
}

export interface StreamState {
  enabled: boolean;
  done: boolean;
  /** Neueste und älteste bisher angenommene Transaktion (ISO). */
  newest: string | null;
  oldest: string | null;
  /** Angenommene Transaktionen. */
  count: number;
}

export interface LoaderOptions {
  userId: string;
  /** Untere Zeitgrenze (ISO); null: bis zum Anfang der Aufzeichnung. */
  since: string | null;
  /** Welche Ströme gelesen werden; Standard: alle drei. */
  streams?: StreamKey[];
  /** Obergrenze für angenommene Öffnungen; danach gilt der Verlauf als gekürzt. */
  maxOpen?: number;
  /** Zeitpunkt (ms), von dem aus zurückgerechnet wird; Standard: jetzt. */
  startedAt?: number;
  pageSize?: number;
  /** Höchstzahl Aufrufe je Anfrage. Der Server lehnt ab etwa 48 ab (Adresse zu lang); mit Cursorn sind ~330 Zeichen je Aufruf. */
  maxCalls?: number;
  /** Zeitscheiben parallel lesen; false liest strikt nacheinander. */
  slicing?: boolean;
  /** Anfang der Aufzeichnung, falls bekannt (etwa die Kontoerstellung): bei „alles“ die Untergrenze für die Planung. */
  planFrom?: number | null;
  /** Eine gebündelte Anfrage mit je einer Abfrage pro Scheibe. Wirft bei Fehlern. */
  fetch: (queries: TxQuery[]) => Promise<TxPage<Stamped>[]>;
}

/** Kleinste Scheibe, die sich noch zu teilen lohnt: so viele Einträge und so viele Millisekunden Restspanne. */
const MIN_SPLIT_ITEMS = 250;
const MIN_SPLIT_SPAN_MS = 2000;
/** Ein Jahr, falls es weder eine Zeitgrenze noch einen bekannten Anfang gibt. */
const FALLBACK_SPAN_MS = 365 * 86_400_000;

/** Cursor, der unmittelbar vor `ms` beginnt: strikt ältere Einträge, keine der Zeit `ms` selbst. */
export function forgeCursor(ms: number): string {
  const json = JSON.stringify([
    { t: 'date', v: new Date(ms).toISOString() },
    { t: 'str', v: '000000000000000000000000' },
  ]);
  return 'v2.' + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Slice {
  id: number;
  stream: StreamKey;
  /** Zeitfenster [lo, hi): nur Einträge darin zählen. */
  lo: number;
  hi: number;
  cursor: string | null;
  /** Zeit des zuletzt gelesenen Eintrags; vor der ersten Seite die obere Grenze. */
  reached: number;
  /** Zeit, bei der die Scheibe begann (obere Grenze oder erster Eintrag). */
  top: number;
  count: number;
  pages: number;
  done: boolean;
  /** Mit selbst gebautem Cursor angelegt und noch nicht erfolgreich gelesen. */
  unconfirmed: boolean;
}

interface Split {
  child: Slice;
  parent: Slice;
  parentLo: number;
}

export class HistoryLoader {
  readonly state: Record<StreamKey, StreamState>;
  /** Die Obergrenze für Öffnungen wurde erreicht, ältere fehlen teilweise. */
  truncated = false;
  /** Gelungene Anfragen. */
  requests = 0;
  /** Zeitscheiben dürfen geteilt werden (wird bei Ablehnung der gebauten Cursor abgeschaltet). */
  slicing: boolean;

  private readonly slices: Slice[] = [];
  private unconfirmed: Split[] = [];
  private readonly startedAt: number;
  private readonly sinceMs: number | null;
  private nextId = 1;
  private rotate = 0;
  private callBudget: number;
  private readonly maxCalls: number;
  private bestProgress = 0;

  constructor(private readonly opts: LoaderOptions) {
    const on = new Set(opts.streams ?? STREAMS);
    const fresh = (k: StreamKey): StreamState => ({ enabled: on.has(k), done: !on.has(k), newest: null, oldest: null, count: 0 });
    this.state = { open: fresh('open'), scrap: fresh('scrap'), sale: fresh('sale') };
    this.startedAt = opts.startedAt ?? Date.now();
    const since = opts.since === null ? NaN : Date.parse(opts.since);
    this.sinceMs = Number.isFinite(since) ? since : null;
    this.maxCalls = Math.max(1, opts.maxCalls ?? 24);
    this.callBudget = this.maxCalls;
    this.slicing = opts.slicing !== false;
    for (const key of STREAMS) {
      if (!on.has(key)) continue;
      this.slices.push({
        id: this.nextId++,
        stream: key,
        lo: this.sinceMs ?? -Infinity,
        hi: Infinity,
        cursor: null,
        reached: this.startedAt,
        top: this.startedAt,
        count: 0,
        pages: 0,
        done: false,
        unconfirmed: false,
      });
    }
  }

  /** Alle gewünschten Ströme sind bis zur Zeitgrenze (oder zum Anfang) gelesen. */
  get done(): boolean {
    return STREAMS.every((k) => this.state[k].done);
  }

  get since(): string | null {
    return this.opts.since;
  }

  /** Zahl der Zeitscheiben, die gerade gelesen werden. */
  get active(): number {
    return this.slices.filter((s) => !s.done).length;
  }

  /** Zeitpunkt der ältesten gelesenen Öffnung (ISO), null solange keine gelesen wurde. */
  get oldestOpen(): string | null {
    return this.state.open.oldest;
  }

  /** Neueste gelesene Transaktion der Ergebnisströme (ISO). */
  get newestOutcome(): string | null {
    const times = [this.state.scrap.newest, this.state.sale.newest].filter((v): v is string => !!v);
    return times.length ? times.sort().pop()! : null;
  }

  // ---------------------------------------------------------------- Schritt

  /** Holt je eine Seite jeder laufenden Scheibe in einer Anfrage und liefert die neuen Transaktionen. */
  async step(): Promise<Pages> {
    const out: Pages = { open: [], scrap: [], sale: [] };
    this.applyFloor();
    this.balance();
    const calls = this.pick();
    if (!calls.length) {
      this.settle();
      return out;
    }
    const started = Date.now();
    let pages: TxPage<Stamped>[];
    try {
      pages = await this.opts.fetch(this.queries(calls));
    } catch (err) {
      // Lehnt der Server die gebauten Cursor ab, zurück zum sequentiellen Lesen und denselben Schritt noch einmal
      if (this.rejectedCursors(err, calls)) return this.step();
      throw err;
    }
    this.requests++;
    this.adapt(Date.now() - started);
    calls.forEach((sl, i) => this.consume(sl, pages[i], out));
    this.settle();
    return out;
  }

  private queries(calls: Slice[]): TxQuery[] {
    return calls.map((sl) => ({
      userId: this.opts.userId,
      types: [TYPE[sl.stream]],
      limit: this.opts.pageSize ?? 100,
      cursor: sl.cursor,
    }));
  }

  /** Scheiben dieses Schritts: höchstens so viele wie das Budget, reihum, damit keine verhungert. */
  private pick(): Slice[] {
    const live = this.slices.filter((s) => !s.done);
    if (live.length <= this.callBudget) return live;
    const start = this.rotate % live.length;
    this.rotate += this.callBudget;
    return Array.from({ length: this.callBudget }, (_, i) => live[(start + i) % live.length]);
  }

  /** Bei langsamen Verbindungen weniger Aufrufe je Anfrage, bei schnellen wieder mehr. */
  private adapt(ms: number): void {
    if (ms > 2500) this.callBudget = Math.max(3, Math.floor(this.callBudget * 0.6));
    else if (ms < 700 && this.callBudget < this.maxCalls) this.callBudget = Math.min(this.maxCalls, this.callBudget + 2);
  }

  // ---------------------------------------------------------------- Antworten

  private consume(sl: Slice, page: TxPage<Stamped> | undefined, out: Pages): void {
    sl.unconfirmed = false;
    sl.pages++;
    const st = this.state[sl.stream];
    const sink: Stamped[] = out[sl.stream];
    const items = page?.items ?? [];
    let reached = false;
    for (const tx of items) {
      if (!tx.createdAt) continue;
      const t = Date.parse(tx.createdAt);
      if (t < sl.lo) {
        reached = true;
        break;
      }
      if (t >= sl.hi) continue;
      sink.push(tx);
      sl.count++;
      if (sl.count === 1) sl.top = Math.min(sl.top, t);
      sl.reached = t;
      st.count++;
      if (st.newest === null || tx.createdAt > st.newest) st.newest = tx.createdAt;
      if (st.oldest === null || tx.createdAt < st.oldest) st.oldest = tx.createdAt;
    }
    sl.cursor = page?.nextCursor ?? null;
    if (reached || !sl.cursor || !items.length) sl.done = true;
    if (sl.stream === 'open' && this.opts.maxOpen !== undefined && st.count >= this.opts.maxOpen && !this.truncated) {
      this.truncated = true;
      for (const o of this.slices) if (o.stream === 'open') o.done = true;
    }
  }

  /** Aktualisiert, welche Ströme fertig sind, und vergisst bestätigte Teilungen. */
  private settle(): void {
    if (this.unconfirmed.length) this.unconfirmed = this.unconfirmed.filter((u) => u.child.pages === 0);
    for (const key of STREAMS) {
      const st = this.state[key];
      if (!st.enabled) continue;
      st.done = this.slices.every((s) => s.stream !== key || s.done);
    }
  }

  // ---------------------------------------------------------------- Zeitgrenze für Ergebnisse

  /**
   * Zerlegungen und Verkäufe liegen immer nach der Öffnung ihres Items. Sind alle Öffnungen gelesen, braucht nichts gelesen
   * zu werden, was älter ist als die älteste Öffnung.
   */
  private applyFloor(): void {
    const open = this.state.open;
    if (!open.enabled || !open.done || !open.oldest) return;
    const floor = Date.parse(open.oldest);
    for (const sl of this.slices) {
      if (sl.stream === 'open' || sl.done) continue;
      if (floor > sl.lo) sl.lo = floor;
      if (sl.reached < sl.lo || sl.hi <= sl.lo) sl.done = true;
    }
    this.settle();
  }

  // ---------------------------------------------------------------- Teilen

  /** Teilt Scheiben, solange noch Aufrufe frei sind und sich eine Teilung lohnt. */
  private balance(): void {
    while (this.slicing && this.active < this.callBudget) {
      const victim = this.pickVictim();
      if (!victim) return;
      this.split(victim);
    }
  }

  /** Geschätzte Zahl noch ungelesener Einträge: Dichte der bisherigen Seiten mal Restspanne. */
  private remaining(sl: Slice): number {
    const span = sl.reached - this.floorOf(sl);
    if (span <= 0) return 0;
    const covered = sl.top - sl.reached;
    if (sl.count < 1 || covered <= 0) return NaN;
    return (sl.count / covered) * span;
  }

  /** Untergrenze einer Scheibe für Planung und Schätzung. */
  private floorOf(sl: Slice): number {
    if (Number.isFinite(sl.lo)) return sl.lo;
    return this.opts.planFrom ?? sl.reached - FALLBACK_SPAN_MS;
  }

  private pickVictim(): Slice | null {
    let best: Slice | null = null;
    let bestRemaining = MIN_SPLIT_ITEMS;
    for (const sl of this.slices) {
      if (sl.done || sl.unconfirmed || sl.pages < 1) continue;
      const rest = this.remaining(sl);
      if (!(rest >= bestRemaining)) continue;
      const floor = this.floorOf(sl);
      if (sl.reached - floor < MIN_SPLIT_SPAN_MS) continue;
      best = sl;
      bestRemaining = rest;
    }
    return best;
  }

  private split(parent: Slice): void {
    const floor = this.floorOf(parent);
    const mid = Math.floor((floor + parent.reached) / 2);
    const child: Slice = {
      id: this.nextId++,
      stream: parent.stream,
      lo: parent.lo,
      hi: mid,
      cursor: forgeCursor(mid),
      reached: mid,
      top: mid,
      count: 0,
      pages: 0,
      done: false,
      unconfirmed: true,
    };
    this.unconfirmed.push({ child, parent, parentLo: parent.lo });
    parent.lo = mid;
    this.slices.push(child);
  }

  /**
   * Prüft nach einem Fehler, ob der Server die gebauten Cursor abgelehnt hat: dann waren unbestätigte Scheiben im Spiel,
   * und die Meldung nennt den Cursor. Bei „ja“ werden die Teilungen zurückgenommen und nicht mehr versucht; sonst wirft
   * der Aufrufer weiter (Netz, Limit, gewöhnliche Serverfehler).
   */
  private rejectedCursors(err: unknown, calls: Slice[]): boolean {
    if (!calls.some((s) => s.unconfirmed)) return false;
    // Die API antwortet auf einen unbrauchbaren Cursor mit HTTP 500 und "Invalid cursor format" bzw. "Cast to ObjectId failed"
    // (geprüft am 2026-11-27). Ein 500 ohne diese Meldung ist ein gewöhnlicher Serverfehler und wird wiederholt.
    const e = err as { status?: number; message?: string } | null;
    const rejected = e?.status === 400 || (e?.status === 500 && /cursor|objectid/i.test(String(e?.message ?? '')));
    if (!rejected) return false;
    this.slicing = false;
    // in umgekehrter Reihenfolge zurücknehmen, damit ursprüngliche Untergrenzen wieder stimmen
    while (this.unconfirmed.length) {
      const { child, parent, parentLo } = this.unconfirmed.pop()!;
      const at = this.slices.indexOf(child);
      if (at >= 0 && child.pages === 0) {
        this.slices.splice(at, 1);
        parent.lo = parentLo;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- Fortschritt

  /**
   * Wie weit der Zeitraum gelesen ist (0 bis 1), geschätzt aus der Dichte der bisherigen Seiten; nie rückläufig. Der Strom,
   * der am wenigsten weit ist, bestimmt es. Ohne Zeitgrenze („alles“) lässt sich nichts schätzen: null bis alles fertig ist.
   */
  progress(): number | null {
    if (this.done) return 1;
    if (this.sinceMs === null) return null;
    let least = 1;
    for (const key of STREAMS) {
      const st = this.state[key];
      if (!st.enabled || st.done) continue;
      let rest = 0;
      let unknown = 0;
      let density = 0;
      let covered = 0;
      for (const sl of this.slices) {
        if (sl.stream !== key || sl.count < 1) continue;
        density += sl.count;
        covered += Math.max(1, sl.top - sl.reached);
      }
      const average = covered > 0 ? density / covered : 0;
      for (const sl of this.slices) {
        if (sl.stream !== key || sl.done) continue;
        const span = Math.max(0, sl.reached - this.floorOf(sl));
        const r = this.remaining(sl);
        if (Number.isNaN(r)) unknown += average * span;
        else rest += r;
      }
      const loaded = st.count;
      const p = loaded + rest + unknown > 0 ? loaded / (loaded + rest + unknown) : 0;
      least = Math.min(least, p);
    }
    this.bestProgress = Math.max(this.bestProgress, Math.min(least, 0.999));
    return this.bestProgress;
  }
}
