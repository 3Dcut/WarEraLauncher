// Nimmt Transaktionen in den Spaltenspeicher auf und ordnet Zerlegungen und Verkäufe den Ziehungen zu, auch wenn sie in
// beliebiger Reihenfolge eintreffen. Beim Nachladen kommen Öffnungen, Zerlegungen und Verkäufe aus getrennten Strömen,
// die in Zeitscheiben parallel gelesen werden; ein Ergebnis kann deshalb lange vor seiner Ziehung da sein.
//
// Wie sich Items wiederfinden lassen (geprüft am 2026-11-27 an 41.629 Öffnungen von 3Dsus):
// - Zerlegung (dismantleItem): dieselbe Item-ID wie die Ziehung; 40.812 von 40.836 Zerlegungen passten, die übrigen 24
//   betrafen Items aus der Zeit vor dem Fenster.
// - Verkauf (itemMarket): der Käufer bekommt eine neue Item-ID, die Transaktion trägt aber Code, Werte und
//   lastAcquisitionAt unverändert. Diese Erwerbszeit stimmte bei 587 von 590 Verkäufen von Items aus dem Fenster auf die
//   Millisekunde mit der Öffnung überein; 163 weitere betrafen Items aus der Zeit davor. Ein Verkauf kann Tage nach der
//   Öffnung liegen (längster Abstand im Fenster: 178 Stunden).
// - Zwei Ziehungen mit gleichem Code, gleichen Werten und gleicher Millisekunde kamen bei 14 von 41.615 Schlüsseln vor.
//   Sie sind gleichwertig, deshalb zählt jede Verkaufstransaktion genau eine davon. Die Item-ID einer Zerlegung ist dagegen
//   eindeutig und gilt vor einem Verkauf: Hatte ein Verkauf sich die zerlegte Ziehung ausgesucht, zieht er zu einem Zwilling um.

import { IdHash, idWords, KIND_OPEN, KIND_SCRAP, KIND_SOLD, NO_ACQ, dayIndex, type PullStore } from './store';

export interface OpenTx {
  _id?: string;
  transactionType?: string;
  itemCode?: string;
  buyerId?: string;
  sellerId?: string;
  createdAt?: string;
  item?: { _id?: string; code?: string; skills?: Record<string, number>; lastAcquisitionAt?: string } | null;
}

export interface ScrapTx {
  _id?: string;
  transactionType?: string;
  createdAt?: string;
  quantity?: number;
  buyerId?: string;
  item?: { _id?: string; code?: string } | null;
}

export interface SaleTx {
  _id?: string;
  transactionType?: string;
  createdAt?: string;
  money?: number;
  sellerId?: string;
  item?: { _id?: string; code?: string; skills?: Record<string, number>; lastAcquisitionAt?: string } | null;
}

const W = new Int32Array(3);
const TWO32 = 4294967296;

export class Intake {
  /** Ziehungen, zu denen es noch kein Ergebnis gibt. */
  open = 0;
  /** Ziehungen ohne Zerlegung nach Item-ID (für Zerlegungen); Einträge zerlegter Ziehungen werden lazy entfernt. */
  private readonly byItem: IdHash;
  /** Offene Ziehungen nach (Kombination, Erwerbszeit) (für Verkäufe). */
  private readonly bySale: IdHash;
  /** Zerlegungen, deren Ziehung noch nicht geladen ist. */
  private readonly scrapPending = new IdHash(256, true);
  /** Verkäufe, deren Ziehung noch nicht geladen ist. */
  private readonly salePending = new IdHash(256, true);
  /** Bereits verarbeitete Verkaufstransaktionen: gleiche Items dürfen mehrfach verkauft werden, die Transaktion zählt einmal. */
  private readonly saleSeen = new IdHash(256);

  constructor(
    readonly store: PullStore,
    readonly userId: string,
  ) {
    // Zerlegte Ziehungen sind erledigt. Verkaufte bleiben über ihre Item-ID auffindbar, falls sich der Verkauf später als der eines
    // Zwillings erweist (siehe rehome); für Verkäufe zählen nur noch offene.
    this.byItem = new IdHash(1024, false, (slot) => store.kind[slot] !== KIND_SCRAP);
    this.bySale = new IdHash(1024, false, (slot) => store.kind[slot] === KIND_OPEN);
  }

  /** Ausstehende Ergebnisse, deren Ziehung noch fehlt (für Tests und Anzeige). */
  get pending(): { scraps: number; sales: number } {
    return { scraps: this.scrapPending.size, sales: this.salePending.size };
  }

  /**
   * Legt eine Öffnung als Ziehung an und liefert ihren Slot, -1 bei fremden oder nicht gewerteten Transaktionen (andere
   * Kisten, anderer Spieler). `cost` ist der Kistenpreis der Minute, NaN bei nachgeladenen Ziehungen.
   */
  addOpen(tx: OpenTx, cost: number): number {
    if (!tx._id || tx.transactionType !== 'openCase' || !tx.createdAt) return -1;
    if (tx.buyerId !== this.userId && tx.sellerId !== this.userId) return -1;
    const kase = tx.itemCode === 'case1' ? 0 : tx.itemCode === 'case2' ? 1 : null;
    if (kase === null) return -1;
    const item = tx.item;
    if (!item?.code) return -1;
    const at = Date.parse(tx.createdAt);
    if (!Number.isFinite(at)) return -1;
    const acq = item.lastAcquisitionAt ? Date.parse(item.lastAcquisitionAt) : NaN;
    let delta = Number.isFinite(acq) ? at - acq : NO_ACQ;
    if (delta !== NO_ACQ && (delta <= -2147483647 || delta >= 2147483647)) delta = NO_ACQ;
    const dict = this.store.dict;
    const combo = dict.comboOf(dict.codeOf(item.code), item.skills);
    const slot = this.store.add(at, delta, kase, combo, cost);
    this.register(slot, item._id ?? tx._id, delta === NO_ACQ ? undefined : acq);
    return slot;
  }

  /** Sucht für eine neue Ziehung ein schon bekanntes Ergebnis, sonst merkt sie sich für später. */
  private register(slot: number, itemId: string, acq: number | undefined): void {
    const store = this.store;
    idWords(itemId, W);
    const a = W[0];
    const b = W[1];
    const c = W[2];
    const pending = this.scrapPending.find(a, b, c);
    if (pending >= 0) {
      store.setOutcome(slot, KIND_SCRAP, this.scrapPending.amt![pending], this.scrapPending.day![pending]);
      this.scrapPending.remove(pending);
      return;
    }
    const combo = store.combo[slot];
    if (acq !== undefined) {
      const lo = acq | 0;
      const hi = Math.floor(acq / TWO32) | 0;
      const sale = this.salePending.find(combo, lo, hi);
      if (sale >= 0) {
        store.setOutcome(slot, KIND_SOLD, this.salePending.amt![sale], this.salePending.day![sale]);
        this.salePending.remove(sale);
        this.byItem.insert(a, b, c, slot);
        return;
      }
      this.bySale.insert(combo, lo, hi, slot);
    }
    this.byItem.insert(a, b, c, slot);
    this.open++;
  }

  /** Zerlegungen des Spielers: gleiche Item-ID wie die Ziehung. Liefert, wie viele Ziehungen dadurch ein Ergebnis bekamen. */
  addScraps(txs: ScrapTx[]): number {
    const store = this.store;
    let matched = 0;
    for (const d of txs) {
      if (d.transactionType !== 'dismantleItem' || d.buyerId !== this.userId || !d.item?._id || !d.createdAt) continue;
      const at = Date.parse(d.createdAt);
      if (!Number.isFinite(at)) continue;
      const amount = d.quantity ?? 0;
      const day = dayIndex(at);
      idWords(d.item._id, W);
      const bucket = this.byItem.find(W[0], W[1], W[2]);
      if (bucket >= 0) {
        const slot = this.byItem.val[bucket];
        this.byItem.remove(bucket);
        const kind = store.kind[slot];
        if (kind === KIND_OPEN) {
          store.setOutcome(slot, KIND_SCRAP, amount, day);
          this.open--;
          matched++;
        } else if (kind === KIND_SOLD) {
          // Ein Verkauf hatte sich diese Ziehung ausgesucht, obwohl er zu einem gleichwertigen Item gehört (gleicher Code, gleiche
          // Werte, gleiche Millisekunde). Die Item-ID der Zerlegung ist eindeutig, also gilt sie, und der Verkauf zieht um.
          if (this.rehome(slot, store.amount[slot], store.oday[slot], amount, day)) matched++;
        }
        continue;
      }
      // Die Ziehung ist noch nicht geladen (oder längst zugeordnet): einmal vormerken
      if (this.scrapPending.find(W[0], W[1], W[2]) < 0) this.scrapPending.insert(W[0], W[1], W[2], 0, amount, day);
    }
    return matched;
  }

  /**
   * Die Ziehung `slot` erweist sich als zerlegt, obwohl ein Verkauf ihr zugeordnet war. Sie bekommt die Zerlegung; der Verkauf
   * geht an eine andere noch offene Ziehung gleichen Schlüssels oder wartet auf eine, die noch geladen wird. Liefert, ob
   * dadurch eine weitere Ziehung ein Ergebnis bekam. So hängt das Endergebnis nicht davon ab, in welcher Reihenfolge Verkäufe
   * und Zerlegungen eintreffen.
   */
  private rehome(slot: number, money: number, soldDay: number, scrapUnits: number, scrapDay: number): boolean {
    const store = this.store;
    store.setOutcome(slot, KIND_SCRAP, scrapUnits, scrapDay);
    const acq = store.acqOf(slot);
    if (acq === undefined) return false;
    const combo = store.combo[slot];
    const lo = acq | 0;
    const hi = Math.floor(acq / TWO32) | 0;
    for (let bucket = this.bySale.find(combo, lo, hi); bucket >= 0; bucket = this.bySale.find(combo, lo, hi)) {
      const twin = this.bySale.val[bucket];
      this.bySale.remove(bucket);
      if (store.kind[twin] === KIND_OPEN) {
        store.setOutcome(twin, KIND_SOLD, money, soldDay);
        this.open--;
        return true;
      }
    }
    this.salePending.insert(combo, lo, hi, 0, money, soldDay);
    return false;
  }

  /** Verkäufe des Spielers: gleicher Code, gleiche Werte, gleiche Erwerbszeit wie die Ziehung. */
  addSales(txs: SaleTx[]): number {
    const store = this.store;
    const dict = store.dict;
    let matched = 0;
    for (const s of txs) {
      if (s.transactionType !== 'itemMarket' || s.sellerId !== this.userId || !s.item?.code || !s.createdAt) continue;
      const acq = Date.parse(s.item.lastAcquisitionAt ?? '');
      const at = Date.parse(s.createdAt);
      if (!Number.isFinite(acq) || !Number.isFinite(at)) continue;
      const combo = dict.comboOf(dict.codeOf(s.item.code), s.item.skills);
      const lo = acq | 0;
      const hi = Math.floor(acq / TWO32) | 0;
      // dieselbe Transaktion nicht zweimal verarbeiten (etwa bei erneutem Lesen der letzten Minuten)
      idWords(s._id ?? `${combo}|${acq}|${s.createdAt}`, W);
      if (this.saleSeen.find(W[0], W[1], W[2]) >= 0) continue;
      this.saleSeen.insert(W[0], W[1], W[2], 0);
      const money = typeof s.money === 'number' ? s.money : 0;
      const day = dayIndex(at);
      let found = -1;
      for (let bucket = this.bySale.find(combo, lo, hi); bucket >= 0; bucket = this.bySale.find(combo, lo, hi)) {
        const slot = this.bySale.val[bucket];
        this.bySale.remove(bucket);
        if (store.kind[slot] === KIND_OPEN) {
          found = slot;
          break;
        }
      }
      if (found >= 0) {
        store.setOutcome(found, KIND_SOLD, money, day);
        this.open--;
        matched++;
      } else {
        this.salePending.insert(combo, lo, hi, 0, money, day);
      }
    }
    return matched;
  }
}
