// Verdichteter Zwischenspeicher einer Sitzung: Der Spaltenspeicher wird verlustfrei zusammengefasst, damit eine Sitzung
// mit Millionen Kisten ein Neuladen übersteht, ohne alles erneut von der API zu lesen.
//
// Die Spalten stehen in Zeitordnung. Zeiten werden als Abstände zur vorigen Ziehung gespeichert (innerhalb eines Bursts
// meist null), Erwerbsabstände und Tage als kleine Differenzen, Kombinationsnummern und Beträge als Varints; Kistenart,
// Ergebnisart und Preise (fast immer unbekannt) als Bytes, auf die deflate ohnehin Läufe findet. Gemessen an 1,04 Millionen
// Ziehungen (25 Kopien der Transaktionen von 3Dsus): 8,45 MB als Varints, 1,85 MB nach deflate, 1,9 Byte je Ziehung
// statt 32 im Speicher. Eine Zusammenfassung zu Zählern je Tag und Kombination wäre kaum kleiner und kostete die
// Reihenfolge, die Verlauf, Zellband und Durststrecken brauchen, sowie die Neubewertung offener Ziehungen.
//
// Damit nach der Wiederherstellung nur die Lücke nachgeladen werden muss, bleibt die neueste Millisekunde draußen
// (`boundary`): alle abgelegten Ziehungen liegen strikt davor, Öffnungen ab `boundary` kommen frisch von der API und
// können keine Doppelten ergeben. Ergebnisse (Zerlegungen und Verkäufe) werden ab `outcomesFrom` erneut gelesen; das ist
// unschädlich, weil Zerlegungen sich über die Item-ID selbst erledigen und die schon verarbeiteten Verkäufe mitgespeichert
// sind. Offene Ziehungen behalten ihre Item-ID, damit späte Zerlegungen sie finden.

import { Intake } from './intake';
import { NO_ACQ, KIND_OPEN, KIND_SOLD, MAX_STATS, PullStore, dayIndex, type DictState } from './store';

export const SNAPSHOT_VERSION = 1;
const MAGIC = [0x57, 0x43, 0x53]; // "WCS"
const RAW = 0;
const DEFLATE = 1;

export interface SnapshotMeta {
  v: number;
  userId: string;
  startedAt: number;
  since: string | null;
  savedAt: number;
  /** Alle abgelegten Ziehungen liegen strikt vor dieser Zeit (ms); Öffnungen ab ihr muss die Sitzung nachladen. */
  boundary: number;
  /** Zerlegungen und Verkäufe sind bis zu dieser Zeit (ms) verarbeitet; ab ihr werden sie erneut gelesen. */
  outcomesFrom: number;
  /** Zahl der abgelegten Ziehungen. */
  n: number;
  /** Beim Laden wurde die Obergrenze erreicht, ältere Kisten fehlen. */
  truncated: boolean;
}

export interface SnapshotInput {
  userId: string;
  startedAt: number;
  since: string | null;
  /** Zeit (ms), vor der alle Ergebnisse verarbeitet sind (der Abgleichstand der Sitzung). */
  outcomesWatermark: number;
  truncated?: boolean;
  now?: number;
}

/** Eine Minute Spielraum für Ergebnisse, die knapp vor dem Abgleichstand liegen. */
const OUTCOME_MARGIN_MS = 60_000;

// ------------------------------------------------------------------ Bytes

class Writer {
  buf: Uint8Array;
  len = 0;

  constructor(cap = 1 << 16) {
    this.buf = new Uint8Array(cap);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  /** Ganze Zahl ab null (auch über 32 Bit) in 7-Bit-Gruppen. */
  uvar(v: number): void {
    this.ensure(9);
    while (v >= 128) {
      this.buf[this.len++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buf[this.len++] = v;
  }

  f32(v: number): void {
    this.ensure(4);
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat32(this.len, v, true);
    this.len += 4;
  }

  /** 32-Bit-Ganzzahl, niederwertiges Byte zuerst. */
  i32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = v & 255;
    this.buf[this.len++] = (v >>> 8) & 255;
    this.buf[this.len++] = (v >>> 16) & 255;
    this.buf[this.len++] = (v >>> 24) & 255;
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Ein Abschnitt mit vorangestellter Länge. */
  section(bytes: Uint8Array): void {
    this.uvar(bytes.length);
    this.raw(bytes);
  }

  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  pos = 0;
  private readonly dv: DataView;

  constructor(readonly buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new RangeError('Zwischenspeicher zu kurz');
    return this.buf[this.pos++];
  }

  uvar(): number {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = this.byte();
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
      if (mul > 2 ** 56) throw new RangeError('Zwischenspeicher beschädigt');
    }
  }

  f32(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError('Zwischenspeicher zu kurz');
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  section(): Uint8Array {
    const len = this.uvar();
    if (this.pos + len > this.buf.length) throw new RangeError('Zwischenspeicher zu kurz');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

const zig = (v: number): number => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzig = (v: number): number => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

const int32s = (bytes: Uint8Array): Int32Array => {
  if (bytes.length % 4) throw new RangeError('Zwischenspeicher beschädigt');
  const out = new Int32Array(bytes.length / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
};

// ------------------------------------------------------------------ Verpacken

/**
 * Packt Spaltenspeicher und Tabellen der Sitzung zu Bytes (noch ohne Kompression). Läuft in einem Zug, damit Ergebnisse,
 * Ziehungen und offene IDs zueinander passen; bei einer Million Ziehungen sind das einige hundert Millisekunden.
 * Liefert null, wenn es nichts abzulegen gibt oder die Zeiten nicht ganzzahlig sind.
 */
export function packSnapshot(store: PullStore, intake: Intake, info: SnapshotInput): Uint8Array | null {
  store.publish();
  const total = store.published;
  if (!total) return null;
  const order = store.order;
  const { at, acqDelta, kase, combo, cost, kind, amount, oday } = store;
  // Die neueste Millisekunde bleibt draußen, damit nachgeladene Öffnungen nicht doppelt zählen
  const newest = at[order[total - 1]];
  let n = total;
  while (n > 0 && at[order[n - 1]] === newest) n--;
  if (n === 0) return null;

  const cols = { at: new Writer(), acq: new Writer(), kase: new Writer(), combo: new Writer(), costMap: new Writer(), cost: new Writer(), kind: new Writer(), amount: new Writer(), amountF: new Writer(), oday: new Writer() };
  const pos = new Int32Array(store.n).fill(-1);
  let previous = 0;
  let floats = 0;
  for (let i = 0; i < n; i++) {
    const s = order[i];
    const t = at[s];
    if (!Number.isInteger(t) || t < 0 || t < previous) return null;
    cols.at.uvar(i === 0 ? t : t - previous);
    previous = t;
    const a = acqDelta[s];
    cols.acq.uvar(a === NO_ACQ ? 0 : zig(a) + 1);
    cols.kase.byte(kase[s]);
    cols.combo.uvar(combo[s]);
    const c = cost[s];
    if (Number.isNaN(c)) cols.costMap.byte(0);
    else {
      cols.costMap.byte(1);
      cols.cost.f32(c);
    }
    const k = kind[s];
    cols.kind.byte(k);
    if (k !== KIND_OPEN) {
      const m = amount[s];
      if (Number.isInteger(m) && m >= 0 && m < 1 << 26) cols.amount.uvar(m * 2);
      else {
        cols.amount.uvar(floats * 2 + 1);
        cols.amountF.f32(m);
        floats++;
      }
      cols.oday.uvar(zig(oday[s] - dayIndex(t)));
    }
    pos[s] = i;
  }

  const openIds = new Writer();
  let openCount = 0;
  intake.forEachOpen((slot, a, b, c) => {
    const p = pos[slot];
    if (p < 0) return;
    openIds.i32(p);
    openIds.i32(a);
    openIds.i32(b);
    openIds.i32(c);
    openCount++;
  });
  const seen = new Writer();
  intake.forEachSeenSale((a, b, c) => {
    seen.i32(a);
    seen.i32(b);
    seen.i32(c);
  });

  const dict = store.dict.exportState();
  const meta: SnapshotMeta = {
    v: SNAPSHOT_VERSION,
    userId: info.userId,
    startedAt: info.startedAt,
    since: info.since,
    savedAt: info.now ?? Date.now(),
    boundary: newest,
    outcomesFrom: Math.min(info.outcomesWatermark, newest) - OUTCOME_MARGIN_MS,
    n,
    truncated: !!info.truncated,
  };
  const header = new TextEncoder().encode(JSON.stringify({ meta, codes: dict.codes, stats: dict.stats, combos: dict.comboCode.length, floats, open: openCount }));
  const out = new Writer(1 << 20);
  out.section(header);
  for (const w of [cols.at, cols.acq, cols.kase, cols.combo, cols.costMap, cols.cost, cols.kind, cols.amount, cols.amountF, cols.oday]) out.section(w.view());
  out.section(new Uint8Array(dict.comboCode.buffer, dict.comboCode.byteOffset, dict.comboCode.byteLength));
  out.section(new Uint8Array(dict.comboVals.buffer, dict.comboVals.byteOffset, dict.comboVals.byteLength));
  out.section(openIds.view());
  out.section(seen.view());
  return out.view();
}

// ------------------------------------------------------------------ Einlesen

interface Header {
  meta: SnapshotMeta;
  codes: string[];
  stats: string[][];
  combos: number;
  floats: number;
  open: number;
}

/** Stellt Spaltenspeicher und Tabellen aus gepackten Bytes her. Wirft bei beschädigten Daten. */
export function unpackSnapshot(raw: Uint8Array): { meta: SnapshotMeta; store: PullStore; intake: Intake } {
  const r = new Reader(raw);
  const header = JSON.parse(new TextDecoder().decode(r.section())) as Header;
  const meta = header.meta;
  if (!meta || meta.v !== SNAPSHOT_VERSION || !Number.isInteger(meta.n) || meta.n < 1) throw new Error('Zwischenspeicher hat ein unbekanntes Format');
  const at = new Reader(r.section());
  const acq = new Reader(r.section());
  const kase = new Reader(r.section());
  const combo = new Reader(r.section());
  const costMap = new Reader(r.section());
  const cost = new Reader(r.section());
  const kind = new Reader(r.section());
  const amount = new Reader(r.section());
  const amountF = new Reader(r.section());
  const oday = new Reader(r.section());
  const comboCodeBytes = r.section();
  const comboValsBytes = r.section();
  const openIds = int32s(r.section());
  const seen = int32s(r.section());

  const comboCode = new Uint16Array(header.combos);
  if (comboCodeBytes.length !== comboCode.byteLength) throw new RangeError('Zwischenspeicher beschädigt');
  new Uint8Array(comboCode.buffer).set(comboCodeBytes);
  const comboVals = new Float64Array(header.combos * MAX_STATS);
  if (comboValsBytes.length !== comboVals.byteLength) throw new RangeError('Zwischenspeicher beschädigt');
  new Uint8Array(comboVals.buffer).set(comboValsBytes);
  const floats: number[] = [];
  for (let i = 0; i < header.floats; i++) floats.push(amountF.f32());

  const store = new PullStore(Math.max(1024, meta.n));
  store.dict.importState({ codes: header.codes, stats: header.stats, comboCode, comboVals } satisfies DictState);
  let t = 0;
  for (let i = 0; i < meta.n; i++) {
    t = i === 0 ? at.uvar() : t + at.uvar();
    const a = acq.uvar();
    const k = kase.byte();
    if (k > 1) throw new RangeError('Zwischenspeicher beschädigt');
    const c = combo.uvar();
    if (c >= header.combos) throw new RangeError('Zwischenspeicher beschädigt');
    const price = costMap.byte() ? cost.f32() : NaN;
    const slot = store.add(t, a === 0 ? NO_ACQ : unzig(a - 1), k as 0 | 1, c, price);
    const kd = kind.byte();
    if (kd > KIND_SOLD) throw new RangeError('Zwischenspeicher beschädigt');
    if (kd !== KIND_OPEN) {
      const code = amount.uvar();
      const value = code % 2 === 0 ? code / 2 : floats[(code - 1) / 2];
      if (value === undefined) throw new RangeError('Zwischenspeicher beschädigt');
      store.setOutcome(slot, kd, value, dayIndex(t) + unzig(oday.uvar()));
    }
  }
  store.publish();
  const intake = new Intake(store, meta.userId);
  intake.restoreTables(openIds, seen);
  return { meta, store, intake };
}

// ------------------------------------------------------------------ Kompression

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** Packt und komprimiert; ohne CompressionStream bleibt es bei den Varints. */
export async function encodeSnapshot(store: PullStore, intake: Intake, info: SnapshotInput): Promise<Uint8Array | null> {
  const raw = packSnapshot(store, intake, info);
  if (!raw) return null;
  const compressed = typeof CompressionStream === 'undefined' ? null : await through(raw, new CompressionStream('deflate-raw'));
  const body = compressed ?? raw;
  const out = new Uint8Array(MAGIC.length + 1 + body.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = compressed ? DEFLATE : RAW;
  out.set(body, MAGIC.length + 1);
  return out;
}

/** Liest einen mit `encodeSnapshot` erzeugten Zwischenspeicher; wirft bei fremden oder beschädigten Daten. */
export async function decodeSnapshot(bytes: Uint8Array): Promise<{ meta: SnapshotMeta; store: PullStore; intake: Intake }> {
  if (bytes.length <= MAGIC.length || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Kein Zwischenspeicher');
  const mode = bytes[MAGIC.length];
  const body = bytes.subarray(MAGIC.length + 1);
  if (mode === RAW) return unpackSnapshot(body);
  if (mode !== DEFLATE || typeof DecompressionStream === 'undefined') throw new Error('Zwischenspeicher lässt sich nicht lesen');
  return unpackSnapshot(await through(body, new DecompressionStream('deflate-raw')));
}
