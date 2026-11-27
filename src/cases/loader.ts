// Liest die Transaktionen eines Spielers seitenweise von neu nach alt, bis zu einer Zeitgrenze.
// Drei Ströme laufen nebeneinander: Öffnungen (openCase), Zerlegungen (dismantleItem) und Verkäufe
// (itemMarket). Je Schritt geht eine einzige gebündelte Anfrage hinaus, die für jeden unfertigen Strom
// eine Seite holt; das zählt gegen das Limit der API nur einmal (siehe assist/limiter.ts).
//
// Warum drei Ströme: Ob ein Item zerlegt oder verkauft wurde, steht nicht an der Öffnung, sondern in
// einer späteren Transaktion. Wer den Verlauf mit echten Ergebnissen rechnen will, braucht alle drei
// im selben Zeitraum. Die Seiten sind nach createdAt absteigend geordnet; der Cursor ist ein Schlüssel
// aus Zeit und ID, deshalb lässt sich ein Strom nur von vorn nach hinten lesen.
//
// Der Loader ändert seinen Stand erst, wenn eine Anfrage gelungen ist. Wirft `fetch`, bleibt alles, wie
// es war, und der nächste Schritt fragt dieselben Seiten noch einmal an.

import type { TxPage, TxQuery, TxType } from '../assist/api';
import type { RawTransaction } from '../battle/logic';
import type { DismantleTx, MarketTx } from './logic';

export type StreamKey = 'open' | 'scrap' | 'sale';
export const STREAMS: StreamKey[] = ['open', 'scrap', 'sale'];

const TYPE: Record<StreamKey, TxType> = { open: 'openCase', scrap: 'dismantleItem', sale: 'itemMarket' };

export interface StreamState {
  enabled: boolean;
  done: boolean;
  cursor: string | null;
  /** Neueste und älteste bisher gelesene Transaktion (ISO). */
  newest: string | null;
  oldest: string | null;
  /** Gelesene Transaktionen innerhalb der Zeitgrenze. */
  count: number;
}

export interface Pages {
  open: RawTransaction[];
  scrap: DismantleTx[];
  sale: MarketTx[];
}

/** Der Loader braucht von einer Transaktion nur den Zeitpunkt; den Rest reicht er unverändert weiter. */
type Stamped = { createdAt?: string };

export interface LoaderOptions {
  userId: string;
  /** Untere Zeitgrenze (ISO); null: bis zum Anfang der Aufzeichnung. */
  since: string | null;
  /** Welche Ströme gelesen werden; Standard: alle drei. */
  streams?: StreamKey[];
  /** Obergrenze für gelesene Öffnungen; danach gilt der Verlauf als gekürzt. */
  maxOpen?: number;
  /** Zeitpunkt (ms), von dem aus zurückgerechnet wird; Standard: jetzt. Bezugspunkt für den Fortschritt. */
  startedAt?: number;
  pageSize?: number;
  /** Eine gebündelte Anfrage mit je einer Abfrage pro Strom. Wirft bei Fehlern. */
  fetch: (queries: TxQuery[]) => Promise<TxPage<Stamped>[]>;
}

export class HistoryLoader {
  readonly state: Record<StreamKey, StreamState>;
  /** Die Obergrenze für Öffnungen wurde erreicht, ältere fehlen. */
  truncated = false;
  /** Gelungene Anfragen. */
  requests = 0;

  private readonly startedAt: number;

  constructor(private readonly opts: LoaderOptions) {
    const on = new Set(opts.streams ?? STREAMS);
    const fresh = (k: StreamKey): StreamState => ({ enabled: on.has(k), done: !on.has(k), cursor: null, newest: null, oldest: null, count: 0 });
    this.state = { open: fresh('open'), scrap: fresh('scrap'), sale: fresh('sale') };
    this.startedAt = opts.startedAt ?? Date.now();
  }

  /** Alle gewünschten Ströme sind bis zur Zeitgrenze (oder zum Anfang) gelesen. */
  get done(): boolean {
    return STREAMS.every((k) => this.state[k].done);
  }

  get since(): string | null {
    return this.opts.since;
  }

  /**
   * Untere Grenze eines Stroms. Zerlegungen und Verkäufe liegen immer nach der Öffnung ihres Items; ist der
   * Öffnungsstrom fertig, braucht also nichts gelesen zu werden, was älter ist als die älteste Öffnung.
   */
  private boundary(key: StreamKey): string | null {
    const since = this.opts.since;
    if (key === 'open') return since;
    const open = this.state.open;
    if (open.enabled && open.done && open.oldest && (since === null || open.oldest > since)) return open.oldest;
    return since;
  }

  /** Holt je eine Seite jedes unfertigen Stroms in einer Anfrage und liefert die neuen Transaktionen. */
  async step(): Promise<Pages> {
    const out: Pages = { open: [], scrap: [], sale: [] };
    const active = STREAMS.filter((k) => !this.state[k].done);
    if (!active.length) return out;
    const queries: TxQuery[] = active.map((k) => ({
      userId: this.opts.userId,
      types: [TYPE[k]],
      limit: this.opts.pageSize ?? 100,
      cursor: this.state[k].cursor,
    }));
    const pages = await this.opts.fetch(queries);
    this.requests++;
    active.forEach((key, i) => {
      const st = this.state[key];
      const page = pages[i];
      const bound = this.boundary(key);
      const sink: Stamped[] = out[key];
      let reached = false;
      for (const tx of page?.items ?? []) {
        if (!tx.createdAt) continue;
        if (bound !== null && tx.createdAt < bound) {
          reached = true;
          break;
        }
        sink.push(tx);
        st.count++;
        st.newest ??= tx.createdAt;
        st.oldest = tx.createdAt;
      }
      st.cursor = page?.nextCursor ?? null;
      if (reached || !st.cursor || !page?.items?.length) st.done = true;
      if (key === 'open' && !st.done && this.opts.maxOpen !== undefined && st.count >= this.opts.maxOpen) {
        st.done = true;
        this.truncated = true;
      }
    });
    return out;
  }

  /**
   * Wie weit der Zeitraum gelesen ist (0 bis 1): der Strom, der am wenigsten weit zurückreicht, bestimmt es.
   * Ohne Zeitgrenze („alles“) lässt sich nichts bemessen; dann null, bis alles fertig ist.
   */
  progress(): number | null {
    if (this.done) return 1;
    const since = this.opts.since === null ? null : Date.parse(this.opts.since);
    if (since === null || !Number.isFinite(since)) return null;
    const span = this.startedAt - since;
    if (span <= 0) return 1;
    let least = 1;
    for (const k of STREAMS) {
      const st = this.state[k];
      if (!st.enabled || st.done) continue;
      const reached = st.oldest ? Date.parse(st.oldest) : this.startedAt;
      least = Math.min(least, Math.max(0, Math.min(1, (this.startedAt - reached) / span)));
    }
    return least;
  }

  /** Zeitpunkt der ältesten gelesenen Öffnung (ISO), null solange keine gelesen wurde. */
  get oldestOpen(): string | null {
    return this.state.open.oldest;
  }

  /** Neueste gelesene Transaktion der Ergebnisströme (ISO), Ausgangspunkt für die Live-Abfrage danach. */
  get newestOutcome(): string | null {
    const times = [this.state.scrap.newest, this.state.sale.newest].filter((v): v is string => !!v);
    return times.length ? times.sort().pop()! : null;
  }
}
