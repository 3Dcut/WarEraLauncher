// Ordnet Zerlegungen und Verkäufe den gezogenen Items zu, auch wenn sie in beliebiger Reihenfolge
// eintreffen. Beim Nachladen langer Zeiträume kommen die Zerlegungen meist vor den Öffnungen an,
// weil beide Listen von neu nach alt gelesen werden und eine Zerlegung nach der Öffnung liegt.
//
// Wie sich Items wiederfinden lassen (geprüft am 2026-11-27 an 41.629 Öffnungen von 3Dsus):
// - Zerlegung (dismantleItem): dieselbe Item-ID wie die Ziehung, 40.812 von 40.836 Zerlegungen passten;
//   die übrigen 24 betrafen Items aus der Zeit vor dem Fenster.
// - Verkauf (itemMarket): der Käufer bekommt eine neue Item-ID, die Transaktion trägt aber Code, Werte
//   und lastAcquisitionAt unverändert. Diese Erwerbszeit stimmte bei allen 587 Verkäufen von Items aus
//   dem Fenster auf die Millisekunde mit der Öffnung überein; drei weitere Verkäufe fanden keine Ziehung,
//   163 betrafen Items aus der Zeit davor. Ein Verkauf kann Tage nach der Öffnung liegen (längster
//   Abstand im Fenster: 178 Stunden).
// - Zwei Ziehungen mit gleichem Code, gleichen Werten und gleicher Millisekunde kamen bei 14 von 41.615
//   Schlüsseln vor. Sie sind gleichwertig, deshalb zählt jede Verkaufstransaktion genau eine davon.

import type { DismantleTx, MarketTx, Outcome, Pull } from './logic';

/** Itemcode und Werte als Schlüssel, unabhängig von der Reihenfolge der Werte. */
export function itemSignature(code: string, skills: Record<string, number> | undefined | null): string {
  let out = code;
  if (skills) {
    for (const k of Object.keys(skills).sort()) out += `|${k}:${skills[k]}`;
  }
  return out;
}

/** Zeitfenster der Suchfächer; Ziehungen und Verkäufe liegen höchstens zwei Fächer auseinander. */
const BUCKET_MS = 2000;
/** Ziehungen mit gemessener Erwerbszeit: gleiche Millisekunde, wenige ms Spielraum als Sicherheit. */
const TOLERANCE_EXACT_MS = 50;
/** Alte gespeicherte Ziehungen kennen nur den Zeitpunkt der Öffnung, die Erwerbszeit liegt etwas davor. */
const TOLERANCE_LEGACY_MS = 2000;

const timeOf = (p: Pull): number => p.acq ?? Date.parse(p.at);
const toleranceOf = (p: Pull): number => (p.acq === undefined ? TOLERANCE_LEGACY_MS : TOLERANCE_EXACT_MS);

interface Meta {
  sig: string;
  bucket: number;
}

interface PendingSale {
  id: string;
  acq: number;
  outcome: Outcome;
}

export type Found = Record<string, Outcome>;

export class OutcomeMatcher {
  private readonly meta = new WeakMap<Pull, Meta>();
  /** Ziehungen ohne Ergebnis, nach Item-ID (für Zerlegungen). */
  private readonly byItem = new Map<string, Pull>();
  /** Ziehungen ohne Ergebnis, nach Itemcode und Werten, dann nach Zeitfach (für Verkäufe). */
  private readonly bySig = new Map<string, Map<number, Pull[]>>();
  /** Alle Ziehungen, die der Matcher schon kennt. */
  private readonly known = new Set<string>();
  /** Zerlegungen, deren Ziehung noch nicht geladen ist (Item-ID → Ergebnis). */
  private readonly scrapPending = new Map<string, Outcome>();
  /** Verkäufe, deren Ziehung noch nicht geladen ist (Schlüssel → Verkäufe). */
  private readonly salePending = new Map<string, PendingSale[]>();
  /** Bereits verarbeitete Verkaufstransaktionen, damit erneutes Lesen nicht zweimal zählt. */
  private readonly saleDone = new Set<string>();
  private readonly scrapDone = new Set<string>();

  constructor(private readonly userId: string) {}

  /** Anzahl Ziehungen, zu denen es noch kein Ergebnis gibt. */
  get open(): number {
    return this.byItem.size;
  }

  /** Neue Ziehungen aufnehmen; `existing` sind schon bekannte Ergebnisse (etwa aus einer gespeicherten Sitzung). */
  addPulls(pulls: Pull[], existing?: Record<string, Outcome>): Found {
    const found: Found = {};
    for (const p of pulls) {
      if (this.known.has(p.id)) continue;
      this.known.add(p.id);
      if (existing?.[p.id]) continue;
      const scrap = this.scrapPending.get(p.itemId);
      if (scrap) {
        this.scrapPending.delete(p.itemId);
        found[p.id] = scrap;
        continue;
      }
      const sale = this.takePendingSale(p);
      if (sale) {
        found[p.id] = sale;
        continue;
      }
      this.index(p);
    }
    return found;
  }

  /** Zerlegungen des Spielers: gleiche Item-ID wie die Ziehung. */
  addScraps(txs: DismantleTx[]): Found {
    const found: Found = {};
    for (const d of txs) {
      if (d.transactionType !== 'dismantleItem' || d.buyerId !== this.userId || !d.item?._id || !d.createdAt) continue;
      const itemId = d.item._id;
      if (this.scrapDone.has(itemId)) continue;
      this.scrapDone.add(itemId);
      const outcome: Outcome = { kind: 'scrapped', at: d.createdAt, amount: d.quantity ?? 0 };
      const p = this.byItem.get(itemId);
      if (p) {
        this.unindex(p);
        found[p.id] = outcome;
      } else {
        this.scrapPending.set(itemId, outcome);
      }
    }
    return found;
  }

  /** Verkäufe des Spielers: gleicher Code, gleiche Werte, gleiche Erwerbszeit wie die Ziehung. */
  addSales(txs: MarketTx[]): Found {
    const found: Found = {};
    for (const s of txs) {
      if (s.transactionType !== 'itemMarket' || s.sellerId !== this.userId || !s.item?.code || !s.createdAt) continue;
      const acq = Date.parse(s.item.lastAcquisitionAt ?? '');
      if (!Number.isFinite(acq)) continue;
      const sig = itemSignature(s.item.code, s.item.skills);
      const id = s._id ?? `${sig}@${acq}@${s.createdAt}`;
      if (this.saleDone.has(id)) continue;
      this.saleDone.add(id);
      const outcome: Outcome = { kind: 'sold', at: s.createdAt, amount: typeof s.money === 'number' ? s.money : 0 };
      const p = this.takePull(sig, acq);
      if (p) found[p.id] = outcome;
      else {
        const list = this.salePending.get(sig);
        if (list) list.push({ id, acq, outcome });
        else this.salePending.set(sig, [{ id, acq, outcome }]);
      }
    }
    return found;
  }

  // ---------------------------------------------------------------- Verzeichnisse

  private index(p: Pull): void {
    const sig = itemSignature(p.itemCode, p.skills);
    const bucket = Math.floor(timeOf(p) / BUCKET_MS);
    this.meta.set(p, { sig, bucket });
    this.byItem.set(p.itemId, p);
    let buckets = this.bySig.get(sig);
    if (!buckets) this.bySig.set(sig, (buckets = new Map()));
    const list = buckets.get(bucket);
    if (list) list.push(p);
    else buckets.set(bucket, [p]);
  }

  private unindex(p: Pull): void {
    this.byItem.delete(p.itemId);
    const meta = this.meta.get(p);
    if (!meta) return;
    const buckets = this.bySig.get(meta.sig);
    const list = buckets?.get(meta.bucket);
    if (!buckets || !list) return;
    const at = list.indexOf(p);
    if (at >= 0) list.splice(at, 1);
    if (!list.length) buckets.delete(meta.bucket);
    if (!buckets.size) this.bySig.delete(meta.sig);
  }

  /** Nächstliegende offene Ziehung mit gleichem Code und gleichen Werten; wird dem Verzeichnis entnommen. */
  private takePull(sig: string, acq: number): Pull | null {
    const buckets = this.bySig.get(sig);
    if (!buckets) return null;
    const center = Math.floor(acq / BUCKET_MS);
    let best: Pull | null = null;
    let bestDistance = Infinity;
    for (let b = center - 1; b <= center + 1; b++) {
      for (const p of buckets.get(b) ?? []) {
        const d = Math.abs(timeOf(p) - acq);
        if (d <= toleranceOf(p) && d < bestDistance) {
          best = p;
          bestDistance = d;
        }
      }
    }
    if (best) this.unindex(best);
    return best;
  }

  private takePendingSale(p: Pull): Outcome | null {
    const sig = itemSignature(p.itemCode, p.skills);
    const list = this.salePending.get(sig);
    if (!list) return null;
    const t = timeOf(p);
    let at = -1;
    let bestDistance = Infinity;
    list.forEach((s, i) => {
      const d = Math.abs(s.acq - t);
      if (d <= toleranceOf(p) && d < bestDistance) {
        at = i;
        bestDistance = d;
      }
    });
    if (at < 0) return null;
    const [taken] = list.splice(at, 1);
    if (!list.length) this.salePending.delete(sig);
    return taken.outcome;
  }
}

/**
 * Ordnet Zerlegungen und Verkäufe den gezogenen Items auf einen Schlag zu. Zerlegte Items behalten ihre ID;
 * verkaufte bekommen beim Käufer eine neue, tragen aber Code, Werte und den Zeitpunkt, zu dem der Verkäufer
 * sie bekam (lastAcquisitionAt).
 */
export function matchOutcomes(pulls: Pull[], userId: string, dismantles: DismantleTx[], sales: MarketTx[]): Found {
  const matcher = new OutcomeMatcher(userId);
  const out: Found = { ...matcher.addPulls(pulls) };
  Object.assign(out, matcher.addScraps(dismantles));
  Object.assign(out, matcher.addSales(sales));
  return out;
}
