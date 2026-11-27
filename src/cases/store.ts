// Spaltenspeicher für Ziehungen. Ein Objekt je Ziehung kostete gut 580 Byte (gemessen bei 155.156 Kisten: 90 MB
// Heap); bei einer Million Kisten wären das über 580 MB. Hier liegt jede Eigenschaft in einem eigenen Typed Array,
// zusammen 32 Byte je Ziehung (eine Million: 32 MB).
//
// - Ziehungen bekommen beim Anhängen eine feste Nummer (Slot). Alles Weitere (Ergebnisse, Hash-Tabellen) bezieht
//   sich auf den Slot; die zeitliche Reihenfolge steht getrennt in `order`.
// - Item und Werte einer Ziehung stehen als Kombinationsnummer im Speicher: ein Itemcode mit bis zu drei Werten.
//   Aus der Kiste fallen nur einige tausend verschiedene Kombinationen; Bewertung und Empfehlung gelten je Kombination.
// - Hash-Tabellen für 96-Bit-IDs (MongoDB-ObjectIds) und für (Kombination, Erwerbszeit) liegen ebenfalls in Typed
//   Arrays. Eine JS-Map mit Text-Schlüsseln braucht je Eintrag über 100 Byte; bei Ergebnissen, die lange vor ihren
//   Ziehungen eintreffen, kämen sonst hunderte MB zusammen.

/** Kennzeichnet in acqDelta eine unbekannte Erwerbszeit. */
export const NO_ACQ = -2147483648;

export const MS_DAY = 86_400_000;
/** Tage werden als Abstand zum 1.1.2020 (UTC) in 16 Bit gespeichert, das reicht für 179 Jahre. */
export const DAY_BASE = Math.floor(Date.UTC(2020, 0, 1) / MS_DAY);
export const dayIndex = (ms: number): number => Math.max(0, Math.min(65535, Math.floor(ms / MS_DAY) - DAY_BASE));
export const dayStartMs = (index: number): number => (index + DAY_BASE) * MS_DAY;

export const KIND_OPEN = 0;
export const KIND_SCRAP = 1;
export const KIND_SOLD = 2;

// ------------------------------------------------------------------ IDs

const HEX24 = /^[0-9a-f]{24}$/i;

function fnv(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h | 0;
}

/** Schreibt eine ID als drei 32-Bit-Wörter in `out`: 24 Hex-Zeichen (ObjectId) verlustfrei, anderer Text als Hash. */
export function idWords(id: string, out: Int32Array | number[], at = 0): void {
  if (id.length === 24 && HEX24.test(id)) {
    out[at] = parseInt(id.slice(0, 8), 16) | 0;
    out[at + 1] = parseInt(id.slice(8, 16), 16) | 0;
    out[at + 2] = parseInt(id.slice(16, 24), 16) | 0;
  } else {
    out[at] = fnv(id, 0x811c9dc5);
    out[at + 1] = fnv(id, 0x1b873593);
    out[at + 2] = fnv(id, 0xcc9e2d51);
  }
}

/** Mischt drei 32-Bit-Wörter zu einem Hash (Murmur3-artig). */
export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0xcc9e2d51);
  h = (h << 15) | (h >>> 17);
  let x = Math.imul(h, 0x1b873593);
  h = Math.imul(b, 0xcc9e2d51);
  h = (h << 15) | (h >>> 17);
  x ^= Math.imul(h, 0x1b873593);
  x = (x << 13) | (x >>> 19);
  x = (Math.imul(x, 5) + 0xe6546b64) | 0;
  h = Math.imul(c, 0xcc9e2d51);
  h = (h << 15) | (h >>> 17);
  x ^= Math.imul(h, 0x1b873593);
  x = (x << 13) | (x >>> 19);
  x = (Math.imul(x, 5) + 0xe6546b64) | 0;
  x ^= 12;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Hash-Tabelle mit offener Adressierung, Schlüssel sind drei 32-Bit-Wörter, Wert eine Ganzzahl und auf Wunsch ein
 * Betrag und ein Tag. Gleiche Schlüssel dürfen mehrfach vorkommen (gleiche Items); `find` liefert den ersten lebenden
 * Eintrag, nach `remove` den nächsten.
 */
export class IdHash {
  private cap: number;
  private mask: number;
  private k0: Int32Array;
  private k1: Int32Array;
  private k2: Int32Array;
  private state: Uint8Array; // 0 leer, 1 belegt, 2 gelöscht
  val: Int32Array;
  amt: Float32Array | null;
  day: Uint16Array | null;
  size = 0;
  private used = 0;

  /**
   * @param alive entscheidet beim Vergrößern, ob ein Eintrag noch gebraucht wird (Wert als Argument); so lassen sich Einträge
   *   lazy löschen, etwa Ziehungen, die inzwischen über den anderen Weg zugeordnet sind.
   */
  constructor(
    initial = 256,
    private readonly payload = false,
    private readonly alive: ((value: number) => boolean) | null = null,
  ) {
    this.cap = 1 << Math.max(4, Math.ceil(Math.log2(Math.max(16, initial))));
    this.mask = this.cap - 1;
    this.k0 = new Int32Array(this.cap);
    this.k1 = new Int32Array(this.cap);
    this.k2 = new Int32Array(this.cap);
    this.state = new Uint8Array(this.cap);
    this.val = new Int32Array(this.cap);
    this.amt = payload ? new Float32Array(this.cap) : null;
    this.day = payload ? new Uint16Array(this.cap) : null;
  }

  /** Bucket des ersten lebenden Eintrags mit diesem Schlüssel, sonst -1. */
  find(a: number, b: number, c: number): number {
    let i = hash3(a, b, c) & this.mask;
    for (;;) {
      const s = this.state[i];
      if (s === 0) return -1;
      if (s === 1 && this.k0[i] === a && this.k1[i] === b && this.k2[i] === c) return i;
      i = (i + 1) & this.mask;
    }
  }

  insert(a: number, b: number, c: number, value: number, amount = 0, day = 0): number {
    if ((this.used + 1) * 10 > this.cap * 6) this.rehash();
    let i = hash3(a, b, c) & this.mask;
    while (this.state[i] === 1) i = (i + 1) & this.mask;
    if (this.state[i] === 0) this.used++;
    this.state[i] = 1;
    this.k0[i] = a;
    this.k1[i] = b;
    this.k2[i] = c;
    this.val[i] = value;
    if (this.amt) this.amt[i] = amount;
    if (this.day) this.day[i] = day;
    this.size++;
    return i;
  }

  remove(bucket: number): void {
    if (this.state[bucket] !== 1) return;
    this.state[bucket] = 2;
    this.size--;
  }

  /** Ruft `fn` für jeden belegten Eintrag auf: Schlüssel, Wert und Bucket. */
  forEach(fn: (a: number, b: number, c: number, value: number, bucket: number) => void): void {
    for (let i = 0; i < this.cap; i++) if (this.state[i] === 1) fn(this.k0[i], this.k1[i], this.k2[i], this.val[i], i);
  }

  /** Vergrößert die Tabelle und wirft Grabsteine hinaus. */
  private rehash(): void {
    const old = { cap: this.cap, k0: this.k0, k1: this.k1, k2: this.k2, state: this.state, val: this.val, amt: this.amt, day: this.day };
    // Vor dem Zählen steht nicht fest, wie viele Einträge wegfallen; großzügig planen, bei Bedarf wächst die Tabelle erneut
    const want = Math.max(256, this.size * 3);
    this.cap = 1 << Math.ceil(Math.log2(want));
    this.mask = this.cap - 1;
    this.k0 = new Int32Array(this.cap);
    this.k1 = new Int32Array(this.cap);
    this.k2 = new Int32Array(this.cap);
    this.state = new Uint8Array(this.cap);
    this.val = new Int32Array(this.cap);
    this.amt = this.payload ? new Float32Array(this.cap) : null;
    this.day = this.payload ? new Uint16Array(this.cap) : null;
    this.size = 0;
    this.used = 0;
    for (let j = 0; j < old.cap; j++) {
      if (old.state[j] !== 1) continue;
      if (this.alive && !this.alive(old.val[j])) continue;
      this.insert(old.k0[j], old.k1[j], old.k2[j], old.val[j], old.amt ? old.amt[j] : 0, old.day ? old.day[j] : 0);
    }
  }
}

// ------------------------------------------------------------------ Items und Kombinationen

/** Mehr Werte als diese drei je Item (Waffen haben zwei) werden nicht gespeichert. */
export const MAX_STATS = 3;

const pack = (x: number): number => (Number.isNaN(x) ? 0 : x + 1);

/** Schlüssel einer Kombination als Zahl, wenn alle Werte ganze Zahlen unter 65535 sind; sonst null (dann gilt ein Text). */
function plainKey(v: number[]): number | null {
  const plain = v.every((x) => Number.isNaN(x) || (Number.isInteger(x) && x >= 0 && x < 65535));
  return plain ? (pack(v[0]) * 65536 + pack(v[1])) * 65536 + pack(v[2]) : null;
}

/** Zustand eines Wörterbuchs für den Zwischenspeicher. */
export interface DictState {
  codes: string[];
  stats: string[][];
  comboCode: Uint16Array;
  /** MAX_STATS Werte je Kombination (NaN: fehlt). */
  comboVals: Float64Array;
}

/**
 * Wörterbuch der Itemcodes und der Kombinationen aus Code und Werten. Die Namen der Werte stehen je Code in der
 * Reihenfolge, in der sie zuerst auftauchen; eine Kombination trägt die Werte in dieser Reihenfolge (NaN: fehlt).
 */
export class ItemDict {
  readonly codes: string[] = [];
  private readonly codeIndex = new Map<string, number>();
  readonly stats: string[][] = [];
  comboCount = 0;
  comboCode = new Uint16Array(512);
  comboVals = new Float64Array(512 * MAX_STATS);
  private readonly comboMap = new Map<number, Map<number, number>>();
  private readonly comboOdd = new Map<string, number>();

  codeOf(code: string): number {
    let i = this.codeIndex.get(code);
    if (i === undefined) {
      i = this.codes.length;
      this.codes.push(code);
      this.stats.push([]);
      this.codeIndex.set(code, i);
    }
    return i;
  }

  /** Kombinationsnummer für einen Code mit diesen Werten; legt sie bei Bedarf an. */
  comboOf(codeIdx: number, skills: Record<string, number> | undefined | null): number {
    const names = this.stats[codeIdx];
    const v = [NaN, NaN, NaN];
    if (skills) {
      for (const key in skills) {
        let at = names.indexOf(key);
        if (at < 0) {
          if (names.length >= MAX_STATS) continue;
          names.push(key);
          at = names.length - 1;
        }
        const value = skills[key];
        if (typeof value === 'number' && Number.isFinite(value)) v[at] = value;
      }
    }
    const key = plainKey(v);
    if (key !== null) {
      let inner = this.comboMap.get(codeIdx);
      if (!inner) this.comboMap.set(codeIdx, (inner = new Map()));
      let id = inner.get(key);
      if (id === undefined) inner.set(key, (id = this.newCombo(codeIdx, v)));
      return id;
    }
    const text = `${codeIdx}|${v[0]}|${v[1]}|${v[2]}`;
    let id = this.comboOdd.get(text);
    if (id === undefined) this.comboOdd.set(text, (id = this.newCombo(codeIdx, v)));
    return id;
  }

  private newCombo(codeIdx: number, v: number[]): number {
    const id = this.comboCount++;
    if (id >= this.comboCode.length) {
      const code = new Uint16Array(this.comboCode.length * 2);
      code.set(this.comboCode);
      this.comboCode = code;
      const vals = new Float64Array(code.length * MAX_STATS);
      vals.set(this.comboVals);
      this.comboVals = vals;
    }
    this.comboCode[id] = codeIdx;
    for (let i = 0; i < MAX_STATS; i++) this.comboVals[id * MAX_STATS + i] = v[i];
    return id;
  }

  /** Der Zustand für den Zwischenspeicher (Kopien). */
  exportState(): DictState {
    return {
      codes: [...this.codes],
      stats: this.stats.map((names) => [...names]),
      comboCode: this.comboCode.slice(0, this.comboCount),
      comboVals: this.comboVals.slice(0, this.comboCount * MAX_STATS),
    };
  }

  /** Stellt ein leeres Wörterbuch aus einem gespeicherten Zustand her; die Kombinationsnummern bleiben dieselben. */
  importState(state: DictState): void {
    if (this.codes.length || this.comboCount) throw new Error('Das Wörterbuch ist nicht leer');
    const count = state.comboCode.length;
    if (state.comboVals.length !== count * MAX_STATS || state.codes.length !== state.stats.length) throw new Error('Wörterbuch passt nicht zusammen');
    state.codes.forEach((code, i) => {
      this.codes.push(code);
      this.stats.push([...state.stats[i]]);
      this.codeIndex.set(code, i);
    });
    let cap = 512;
    while (cap < count) cap *= 2;
    this.comboCode = new Uint16Array(cap);
    this.comboVals = new Float64Array(cap * MAX_STATS);
    this.comboCode.set(state.comboCode);
    this.comboVals.set(state.comboVals);
    for (let id = 0; id < count; id++) {
      const codeIdx = state.comboCode[id];
      if (codeIdx >= state.codes.length) throw new Error('Wörterbuch verweist auf einen unbekannten Code');
      const v = [state.comboVals[id * MAX_STATS], state.comboVals[id * MAX_STATS + 1], state.comboVals[id * MAX_STATS + 2]];
      const key = plainKey(v);
      if (key !== null) {
        let inner = this.comboMap.get(codeIdx);
        if (!inner) this.comboMap.set(codeIdx, (inner = new Map()));
        inner.set(key, id);
      } else {
        this.comboOdd.set(`${codeIdx}|${v[0]}|${v[1]}|${v[2]}`, id);
      }
    }
    this.comboCount = count;
  }

  /** Die Werte einer Kombination als Objekt (Name → Wert), wie sie die Schätzung braucht. */
  skillsOf(combo: number): Record<string, number> {
    const names = this.stats[this.comboCode[combo]];
    const out: Record<string, number> = {};
    for (let i = 0; i < names.length; i++) {
      const value = this.comboVals[combo * MAX_STATS + i];
      if (!Number.isNaN(value)) out[names[i]] = value;
    }
    return out;
  }
}

// ------------------------------------------------------------------ Speicher

export class PullStore {
  readonly dict = new ItemDict();
  /** Anzahl der Ziehungen (Slots), veröffentlicht oder nicht. */
  n = 0;
  private cap = 0;
  at = new Float64Array(0);
  /** createdAt minus lastAcquisitionAt in ms; NO_ACQ, wenn unbekannt. */
  acqDelta = new Int32Array(0);
  /** 0 = grüne Kiste (case1), 1 = rote (case2). */
  kase = new Uint8Array(0);
  combo = new Uint32Array(0);
  /** Kistenpreis, als die Öffnung live erkannt wurde; NaN: unbekannt (dann zählt das Tagesmittel). */
  cost = new Float32Array(0);
  kind = new Uint8Array(0);
  amount = new Float32Array(0);
  /** Tag des Ergebnisses (dayIndex). */
  oday = new Uint16Array(0);
  /** Slots in zeitlicher Reihenfolge (älteste zuerst), gültig für die ersten `published` Einträge. */
  order: Uint32Array = new Uint32Array(0);
  published = 0;
  /** Ziehungen je Kistenart. */
  readonly counts: [number, number] = [0, 0];

  constructor(initial = 1024) {
    this.grow(initial);
  }

  private grow(min: number): void {
    if (min <= this.cap) return;
    let cap = Math.max(1024, this.cap * 2);
    while (cap < min) cap *= 2;
    const at = new Float64Array(cap);
    at.set(this.at.subarray(0, this.n));
    this.at = at;
    const acq = new Int32Array(cap);
    acq.set(this.acqDelta.subarray(0, this.n));
    this.acqDelta = acq;
    const kase = new Uint8Array(cap);
    kase.set(this.kase.subarray(0, this.n));
    this.kase = kase;
    const combo = new Uint32Array(cap);
    combo.set(this.combo.subarray(0, this.n));
    this.combo = combo;
    const cost = new Float32Array(cap).fill(NaN);
    cost.set(this.cost.subarray(0, this.n));
    this.cost = cost;
    const kind = new Uint8Array(cap);
    kind.set(this.kind.subarray(0, this.n));
    this.kind = kind;
    const amount = new Float32Array(cap);
    amount.set(this.amount.subarray(0, this.n));
    this.amount = amount;
    const oday = new Uint16Array(cap);
    oday.set(this.oday.subarray(0, this.n));
    this.oday = oday;
    this.cap = cap;
  }

  /** Hängt eine Ziehung an und liefert ihren Slot. */
  add(at: number, acqDeltaMs: number, kase: 0 | 1, combo: number, cost: number): number {
    if (this.n >= this.cap) this.grow(this.n + 1);
    const slot = this.n++;
    this.at[slot] = at;
    this.acqDelta[slot] = acqDeltaMs;
    this.kase[slot] = kase;
    this.combo[slot] = combo;
    this.cost[slot] = cost;
    this.kind[slot] = KIND_OPEN;
    this.counts[kase]++;
    return slot;
  }

  setOutcome(slot: number, kind: number, amount: number, day: number): void {
    this.kind[slot] = kind;
    this.amount[slot] = amount;
    this.oday[slot] = day;
  }

  /** Erwerbszeit (ms) der Ziehung, undefined wenn unbekannt. */
  acqOf(slot: number): number | undefined {
    const d = this.acqDelta[slot];
    return d === NO_ACQ ? undefined : this.at[slot] - d;
  }

  /** Nimmt die seit dem letzten Veröffentlichen angehängten Ziehungen in die Zeitordnung auf; liefert ihre Zahl. */
  publish(): number {
    const m = this.n - this.published;
    if (m <= 0) return 0;
    const fresh = new Uint32Array(m);
    let sorted = true;
    for (let i = 0; i < m; i++) {
      fresh[i] = this.published + i;
      if (i > 0 && this.at[fresh[i]] < this.at[fresh[i - 1]]) sorted = false;
    }
    const at = this.at;
    if (!sorted) fresh.sort((a, b) => at[a] - at[b] || a - b);
    this.order = mergeOrder(this.order, this.published, fresh, at);
    this.published = this.n;
    return m;
  }

  /** Zeit der ältesten und der jüngsten veröffentlichten Ziehung (ms), null ohne Ziehungen. */
  span(): { first: number; last: number } | null {
    return this.published ? { first: this.at[this.order[0]], last: this.at[this.order[this.published - 1]] } : null;
  }
}

/**
 * Mischt die nach Zeit sortierten neuen Slots in die bestehende Ordnung. Die Einfügestellen werden per Bisektion
 * gefunden und die Blöcke dazwischen kopiert; das kostet bei einer Million Ziehungen und wenigen tausend neuen
 * etwa eine Millisekunde statt eines vollständigen Sortierens.
 */
export function mergeOrder(old: Uint32Array, oldLen: number, fresh: Uint32Array, at: Float64Array): Uint32Array {
  const out = new Uint32Array(oldLen + fresh.length);
  let src = 0;
  let pos = 0;
  for (let j = 0; j < fresh.length; j++) {
    const slot = fresh[j];
    const t = at[slot];
    let lo = src;
    let hi = oldLen;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const o = old[mid];
      const ot = at[o];
      if (ot < t || (ot === t && o < slot)) lo = mid + 1;
      else hi = mid;
    }
    if (lo > src) {
      out.set(old.subarray(src, lo), pos);
      pos += lo - src;
      src = lo;
    }
    out[pos++] = slot;
  }
  if (src < oldLen) out.set(old.subarray(src, oldLen), pos);
  return out;
}
