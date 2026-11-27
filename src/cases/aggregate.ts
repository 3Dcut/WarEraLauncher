// Alle Auswertungen über sämtliche Ziehungen in einem einzigen Durchlauf, ohne Objekt je Ziehung. Bei einer Million
// Kisten dauert das wenige Dutzend Millisekunden. Was pro Ziehung gebraucht wird, steht in Typed Arrays: Bewertung und
// Empfehlung gelten je Kombination aus Code und Werten (aus der Kiste fallen nur einige tausend), Preise je Tag.
//
// Der Verlauf wird in Fächer gebündelt, deren Grenzen alle Ziehungen gleichmäßig verteilen. Je Fach bleiben Endwert und
// Min/Max des Ergebnisses; so fließt jede einzelne Kiste in die Grafik ein, auch wenn sie nur 1.200 Punkte breit ist.

import { DAY_BASE, KIND_OPEN, KIND_SOLD, MS_DAY, type PullStore } from './store';

/** Bewertung je Kombination aus Code und Werten (Index = Kombinationsnummer). */
export interface ComboTable {
  /** Seltenheit 0 (gewöhnlich) bis 5 (mythisch), -1 unbekannt. */
  rank: Int8Array;
  /** Geschätzter Verkaufswert, NaN ohne Marktdaten. */
  sale: Float32Array;
  /** Schrottwert bei voller Haltbarkeit (Einheiten mal Schrottpreis). */
  scrapValue: Float32Array;
  /** Wert nach Empfehlung. */
  value: Float32Array;
  /** 1: lohnt den Verkauf. */
  sell: Uint8Array;
}

export interface AggParams {
  /** -1: alle, sonst nur diese Kistenart (0 grün, 1 rot). */
  filter: -1 | 0 | 1;
  /** Eigener Kistenpreis je Art; null: Preis der Öffnung. */
  custom: [number | null, number | null];
  /** Aktueller Kistenpreis je Art, letzter Ausweg (NaN: keiner). */
  current: [number, number];
  /** Aktueller Schrottpreis, Ausweg für Tage ohne Mittel. */
  scrapNow: number;
  /** Erwartung und Streuung je Kiste und Art. */
  ev: [number, number];
  sd: [number, number];
  /** Höchstzahl Fächer des Verlaufs. */
  buckets: number;
  /** Erster Tag der Preisfelder (dayIndex). */
  minDay: number;
  /** Tagesmittel der Kisten je Art und des Schrotts, ab minDay (NaN: kein Mittel). */
  costByDay: [Float32Array, Float32Array];
  scrapByDay: Float32Array;
  /** Schrott je Seltenheit (Einheiten). */
  unitsByRank: ArrayLike<number>;
  combos: ComboTable;
}

export interface Series {
  /** Anzahl Ziehungen im Verlauf. */
  n: number;
  /** Anzahl Fächer. */
  buckets: number;
  /** Ziehungen bis zum Ende von Fach i (Länge buckets+1, erster Eintrag 0). */
  end: Float64Array;
  /** Ergebnis, Erwartung und Streuungsband am Ende von Fach i (Länge buckets+1, erster Eintrag 0). */
  actual: Float64Array;
  expected: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
  /** Kleinster und größter Ergebniswert innerhalb von Fach i, einschließlich des Anfangswerts (Länge buckets). */
  min: Float64Array;
  max: Float64Array;
}

export interface Drought {
  /** Ziehungen seit dem letzten Item ab dieser Seltenheit. */
  since: number;
  /** Längste Serie ohne ein solches Item. */
  longest: number;
}

export interface Aggregates {
  n: number;
  count: [number, number];
  cost: number;
  /** Ziehungen ohne bekannten Kistenpreis. */
  costMissing: number;
  expected: number;
  scrapAll: number;
  saleAll: number;
  value: number;
  sellCount: number;
  scrapCount: number;
  scrapUnits: number;
  sold: number;
  scrapped: number;
  /** Ziehungen je Seltenheit 0 bis 5; Unbekannte stehen in `unknown`. */
  rarity: number[];
  unknown: number;
  /** Schrott-Einheiten aller Ziehungen, der Maßstab für Glück. */
  luckScore: number;
  /** Durststrecken ab Selten (Rang 2) und ab Episch (Rang 3). */
  rare: Drought;
  epic: Drought;
  series: Series;
  /** Je Ziehung in zeitlicher Reihenfolge: Seltenheit + 1, 0 unbekannt. */
  strip: Uint8Array;
  /** Slots der Ziehungen, die sich zu verkaufen lohnen. */
  sellSlots: Uint32Array;
  /** Schrott-Empfehlungen nach Seltenheit (Index Rang + 1, 0 unbekannt): Zahl, Einheiten, davon erledigt. */
  scrapGroups: { count: number[]; units: number[]; done: number[] };
}

export function emptySeries(): Series {
  return {
    n: 0,
    buckets: 0,
    end: new Float64Array(1),
    actual: new Float64Array(1),
    expected: new Float64Array(1),
    lo: new Float64Array(1),
    hi: new Float64Array(1),
    min: new Float64Array(0),
    max: new Float64Array(0),
  };
}

export function aggregate(store: PullStore, p: AggParams): Aggregates {
  const { order, published, kase, combo, cost, kind, amount, oday, at } = store;
  const { rank: rankOf, sale: saleOf, scrapValue: scrapOf, value: valueOf, sell: sellOf } = p.combos;

  // Anzahl der Ziehungen, die der Filter durchlässt
  const total = published;
  let m = 0;
  if (p.filter < 0) m = total;
  else {
    for (let k = 0; k < total; k++) if (kase[order[k]] === p.filter) m++;
  }

  const B = Math.max(0, Math.min(p.buckets, m));
  const end = new Float64Array(B + 1);
  const actualS = new Float64Array(B + 1);
  const expectedS = new Float64Array(B + 1);
  const loS = new Float64Array(B + 1);
  const hiS = new Float64Array(B + 1);
  const minS = new Float64Array(B);
  const maxS = new Float64Array(B);
  const strip = new Uint8Array(m);
  const sell: number[] = [];

  const count: [number, number] = [0, 0];
  const rarity = [0, 0, 0, 0, 0, 0];
  let unknown = 0;
  const gCount = new Array(7).fill(0) as number[];
  const gUnits = new Array(7).fill(0) as number[];
  const gDone = new Array(7).fill(0) as number[];

  let sumCost = 0;
  let costMissing = 0;
  let expected = 0;
  let scrapAll = 0;
  let saleAll = 0;
  let value = 0;
  let sellCount = 0;
  let scrapUnits = 0;
  let sold = 0;
  let scrapped = 0;

  // Serie
  let actual = 0;
  let exp = 0;
  let variance = 0;
  let bucket = 0;
  let nextEnd = B ? Math.round(m / B) : 0;
  let bMin = 0;
  let bMax = 0;
  let j = 0;

  // Durststrecken
  let runRare = 0;
  let runEpic = 0;
  let longRare = 0;
  let longEpic = 0;

  const { custom, current, ev, sd, minDay, costByDay, scrapByDay, unitsByRank, scrapNow } = p;
  const dayCount0 = costByDay[0].length;
  const dayCount1 = costByDay[1].length;
  const scrapDays = scrapByDay.length;
  const sd0 = sd[0] * sd[0];
  const sd1 = sd[1] * sd[1];
  const filter = p.filter;

  for (let k = 0; k < total; k++) {
    const slot = order[k];
    const c = kase[slot];
    if (filter >= 0 && c !== filter) continue;
    count[c]++;
    const cb = combo[slot];
    const rank = rankOf[cb];

    // Seltenheit
    if (rank >= 0) {
      rarity[rank]++;
      strip[j] = rank + 1;
      if (rank >= 2) {
        if (runRare > longRare) longRare = runRare;
        runRare = 0;
      } else runRare++;
      if (rank >= 3) {
        if (runEpic > longEpic) longEpic = runEpic;
        runEpic = 0;
      } else runEpic++;
    } else {
      unknown++;
      strip[j] = 0;
      runRare++;
      runEpic++;
    }

    // Kosten: eigener Preis, sonst Preis der Öffnung, sonst Tagesmittel, sonst Preis von jetzt
    const own = custom[c];
    let price: number;
    if (own !== null) price = own;
    else {
      price = cost[slot];
      if (price !== price) {
        const d = ((at[slot] / MS_DAY) | 0) - DAY_BASE - minDay;
        price = d >= 0 && d < (c === 0 ? dayCount0 : dayCount1) ? costByDay[c][d] : NaN;
        if (price !== price) price = current[c];
      }
    }
    if (price !== price) costMissing++;
    else sumCost += price;

    // Wert: echtes Ergebnis, sonst Empfehlung von jetzt
    const kd = kind[slot];
    let v: number;
    if (kd === KIND_OPEN) v = valueOf[cb];
    else if (kd === KIND_SOLD) {
      v = amount[slot];
      sold++;
    } else {
      const d = oday[slot] - minDay;
      let sp = d >= 0 && d < scrapDays ? scrapByDay[d] : NaN;
      if (sp !== sp) sp = scrapNow;
      v = amount[slot] * sp;
      scrapped++;
    }
    value += v;

    // Empfehlung
    const sl = saleOf[cb];
    scrapAll += scrapOf[cb];
    saleAll += sl !== sl ? scrapOf[cb] : sl;
    const units = rank >= 0 ? (unitsByRank[rank] as number) : 0;
    if (sellOf[cb]) {
      sellCount++;
      sell.push(slot);
    } else {
      scrapUnits += units;
      const g = rank + 1;
      gCount[g]++;
      gUnits[g] += units;
      if (kd !== KIND_OPEN) gDone[g]++;
    }

    // Erwartung und Verlauf
    const e = ev[c];
    expected += e;
    const cc = price !== price ? 0 : price;
    actual += v - cc;
    exp += e - cc;
    variance += c === 0 ? sd0 : sd1;
    j++;
    if (B) {
      if (actual < bMin) bMin = actual;
      if (actual > bMax) bMax = actual;
      if (j === nextEnd) {
        end[bucket + 1] = j;
        actualS[bucket + 1] = actual;
        expectedS[bucket + 1] = exp;
        const s = Math.sqrt(variance);
        loS[bucket + 1] = exp - s;
        hiS[bucket + 1] = exp + s;
        minS[bucket] = bMin;
        maxS[bucket] = bMax;
        bucket++;
        bMin = actual;
        bMax = actual;
        nextEnd = Math.round(((bucket + 1) * m) / B);
      }
    }
  }

  let luckScore = 0;
  for (let r = 0; r < 6; r++) luckScore += rarity[r] * 6 * 3 ** r;

  return {
    n: j,
    count,
    cost: sumCost,
    costMissing,
    expected,
    scrapAll,
    saleAll,
    value,
    sellCount,
    scrapCount: j - sellCount,
    scrapUnits,
    sold,
    scrapped,
    rarity,
    unknown,
    luckScore,
    rare: { since: runRare, longest: Math.max(longRare, runRare) },
    epic: { since: runEpic, longest: Math.max(longEpic, runEpic) },
    series: { n: j, buckets: B, end, actual: actualS, expected: expectedS, lo: loS, hi: hiS, min: minS, max: maxS },
    strip,
    sellSlots: Uint32Array.from(sell),
    scrapGroups: { count: gCount, units: gUnits, done: gDone },
  };
}
