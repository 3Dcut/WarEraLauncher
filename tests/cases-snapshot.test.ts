import { describe, it, expect } from 'vitest';
import { Intake, type OpenTx, type SaleTx, type ScrapTx } from '../src/cases/intake';
import { PullStore, KIND_OPEN, KIND_SCRAP, KIND_SOLD, NO_ACQ } from '../src/cases/store';
import { packSnapshot, unpackSnapshot, encodeSnapshot, decodeSnapshot, SNAPSHOT_VERSION } from '../src/cases/snapshot';
import { rng } from '../src/cases/logic';

const ME = 'me';
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const hex = (n: number) => n.toString(16).padStart(24, '0');

interface Fixture {
  store: PullStore;
  intake: Intake;
  opens: OpenTx[];
  scraps: ScrapTx[];
  sales: SaleTx[];
}

/**
 * Eine Sitzung aus n Öffnungen in Bursts von je `burst` gleichzeitigen, davon etwa 4 % verkauft, 90 % zerlegt, der Rest offen.
 * Dazu krumme Fälle: fehlende Erwerbszeit, Kistenpreise, nicht ganzzahlige Werte, mehr als drei Werte, Beträge mit Nachkommastellen.
 */
function session(n: number, seed = 1, burst = 7): Fixture {
  const rand = rng(seed);
  const store = new PullStore(16);
  const intake = new Intake(store, ME);
  const opens: OpenTx[] = [];
  const scraps: ScrapTx[] = [];
  const sales: SaleTx[] = [];
  const codes = ['helmet1', 'chest2', 'sword3', 'gloves1', 'rifle'];
  for (let i = 0; i < n; i++) {
    const at = T0 + Math.floor(i / burst) * 4100 + (i % burst < 2 ? 0 : 1);
    const code = codes[Math.floor(rand() * codes.length)];
    const odd = i % 97 === 0;
    const skills: Record<string, number> = odd ? { armor: 5.5, dodge: 3, speed: 2, extra: 9 } : { armor: 1 + Math.floor(rand() * 9) };
    const hasAcq = i % 53 !== 0;
    const acq = at - (hasAcq ? 3 + Math.floor(rand() * 4) : 0) - (i % 211 === 0 ? 9_000 : 0);
    const tx: OpenTx = {
      _id: hex(0x600000 + i),
      transactionType: 'openCase',
      itemCode: i % 11 === 0 ? 'case2' : 'case1',
      buyerId: ME,
      sellerId: ME,
      createdAt: iso(at),
      item: { _id: hex(0x700000 + i), code, skills, ...(hasAcq ? { lastAcquisitionAt: iso(acq) } : {}) },
    };
    opens.push(tx);
    const live = i % 13 === 0;
    intake.addOpen(tx, live ? 3.99 + (i % 5) * 0.01 : NaN);
    const r = rand();
    if (r < 0.9) scraps.push({ _id: hex(0x500000 + i), transactionType: 'dismantleItem', buyerId: ME, createdAt: iso(at + 60_000 + (i % 3) * 86_400_000), quantity: [6, 18, 54, 162][i % 4], item: { _id: hex(0x700000 + i) } });
    else if (r < 0.94 && hasAcq)
      sales.push({ _id: hex(0x400000 + i), transactionType: 'itemMarket', sellerId: ME, createdAt: iso(at + 3_600_000 * (1 + (i % 5))), money: 7.123 + (i % 17) * 1.37, item: { _id: hex(0x800000 + i), code, skills, lastAcquisitionAt: iso(acq) } });
  }
  intake.addScraps(scraps);
  intake.addSales(sales);
  store.publish();
  return { store, intake, opens, scraps, sales };
}

/** Die Spalten in Zeitordnung ohne die neueste Millisekunde. */
function columns(store: PullStore, upTo = store.published) {
  const rows: unknown[][] = [];
  for (let i = 0; i < upTo; i++) {
    const s = store.order[i];
    rows.push([store.at[s], store.acqDelta[s], store.kase[s], store.combo[s], Number.isNaN(store.cost[s]) ? 'NaN' : store.cost[s], store.kind[s], store.kind[s] === KIND_OPEN ? 0 : store.amount[s], store.kind[s] === KIND_OPEN ? 0 : store.oday[s]]);
  }
  return rows;
}

const info = { userId: ME, startedAt: T0 - 5000, since: null as string | null, outcomesWatermark: T0 + 10_000 };

describe('Zwischenspeicher: Rundlauf', () => {
  it('stellt Spalten, Wörterbuch und Zähler verlustfrei her', () => {
    const { store, intake } = session(3000, 3);
    const raw = packSnapshot(store, intake, info)!;
    expect(raw).not.toBeNull();
    const back = unpackSnapshot(raw);
    // die neueste Millisekunde bleibt draußen
    const newest = store.at[store.order[store.published - 1]];
    let kept = store.published;
    while (kept > 0 && store.at[store.order[kept - 1]] === newest) kept--;
    expect(back.meta.n).toBe(kept);
    expect(back.meta.boundary).toBe(newest);
    expect(back.store.published).toBe(kept);
    expect(columns(back.store)).toEqual(columns(store, kept));
    // Wörterbuch: gleiche Kombinationsnummern, gleiche Werte
    expect(back.store.dict.codes).toEqual(store.dict.codes);
    expect(back.store.dict.stats).toEqual(store.dict.stats);
    expect(back.store.dict.comboCount).toBe(store.dict.comboCount);
    for (let c = 0; c < store.dict.comboCount; c++) expect(back.store.dict.skillsOf(c)).toEqual(store.dict.skillsOf(c));
    // dieselbe Kombination bekommt nach dem Einlesen dieselbe Nummer
    const dict = back.store.dict;
    for (let c = 0; c < store.dict.comboCount; c++) expect(dict.comboOf(dict.comboCode[c], dict.skillsOf(c))).toBe(c);
    // Zähler: Ziehungen je Kistenart und offene Ziehungen
    const open = columns(store, kept).filter((r) => r[5] === KIND_OPEN).length;
    expect(back.intake.open).toBe(open);
    expect(back.store.counts[0] + back.store.counts[1]).toBe(kept);
  });

  it('nimmt Erwerbszeit, Preise, krumme Werte und Beträge mit', () => {
    const { store, intake } = session(1500, 11);
    const back = unpackSnapshot(packSnapshot(store, intake, info)!);
    const rows = columns(back.store);
    expect(rows.some((r) => r[1] === NO_ACQ)).toBe(true);
    expect(rows.some((r) => r[4] !== 'NaN')).toBe(true);
    expect(rows.some((r) => r[5] === KIND_SOLD && !Number.isInteger(r[6] as number))).toBe(true);
    expect(rows.some((r) => r[5] === KIND_SCRAP && (r[6] as number) >= 6)).toBe(true);
    expect(rows.some((r) => (r[7] as number) > 0)).toBe(true);
    // Beträge sind Float32 und kommen bitgleich zurück
    expect(rows).toEqual(columns(store, back.store.published));
  });

  it('komprimiert und liest zurück, auch mit Rohform als Ausweichweg', async () => {
    const { store, intake } = session(5000, 5);
    const bytes = (await encodeSnapshot(store, intake, info))!;
    const raw = packSnapshot(store, intake, info)!;
    expect(bytes.length).toBeLessThan(raw.length * 0.8);
    // Kopf: Kennung, Art
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0x57, 0x43, 0x53]);
    const back = await decodeSnapshot(bytes);
    expect(columns(back.store)).toEqual(columns(store, back.store.published));
    // unkomprimiert gespeicherte Daten (Art 0) liest die Gegenstelle ebenfalls
    const plain = new Uint8Array(4 + raw.length);
    plain.set([0x57, 0x43, 0x53, 0], 0);
    plain.set(raw, 4);
    expect(columns((await decodeSnapshot(plain)).store)).toEqual(columns(back.store));
  });

  it('braucht je Ziehung nur wenige Byte', async () => {
    const { store, intake } = session(40_000, 7, 25);
    const bytes = (await encodeSnapshot(store, intake, info))!;
    expect(bytes.length / store.n).toBeLessThan(4);
  });

  it('legt nichts ab, wenn es keine Ziehung vor der neuesten Millisekunde gibt', () => {
    const store = new PullStore(16);
    const intake = new Intake(store, ME);
    expect(packSnapshot(store, intake, info)).toBeNull();
    const one: OpenTx = { _id: hex(1), transactionType: 'openCase', itemCode: 'case1', buyerId: ME, sellerId: ME, createdAt: iso(T0), item: { _id: hex(2), code: 'helmet1', skills: { armor: 3 } } };
    intake.addOpen(one, NaN);
    intake.addOpen({ ...one, _id: hex(3), item: { ...one.item, _id: hex(4) } }, NaN);
    expect(packSnapshot(store, intake, info)).toBeNull();
  });

  it('merkt sich Grenze und Abgleichstand für das Nachholen', () => {
    const { store, intake } = session(500, 2);
    const newest = store.at[store.order[store.published - 1]];
    // Abgleichstand jünger als die Grenze: die Grenze gilt, mit einer Minute Spielraum
    const a = unpackSnapshot(packSnapshot(store, intake, { ...info, outcomesWatermark: newest + 600_000 })!);
    expect(a.meta.outcomesFrom).toBe(newest - 60_000);
    // Abgleichstand älter als die Grenze: er gilt
    const b = unpackSnapshot(packSnapshot(store, intake, { ...info, outcomesWatermark: newest - 7_200_000, now: 123 })!);
    expect(b.meta.outcomesFrom).toBe(newest - 7_200_000 - 60_000);
    expect(b.meta.savedAt).toBe(123);
    expect(b.meta).toMatchObject({ v: SNAPSHOT_VERSION, userId: ME, startedAt: info.startedAt, since: null, truncated: false });
    // der Hinweis auf eine gekürzte Ladung bleibt erhalten
    expect(unpackSnapshot(packSnapshot(store, intake, { ...info, truncated: true })!).meta.truncated).toBe(true);
  });
});

describe('Zwischenspeicher: Wiederaufnahme der Zuordnung', () => {
  it('ordnet späte Zerlegungen offener Ziehungen auch nach dem Einlesen zu', () => {
    const { store, intake, opens } = session(2000, 4);
    const back = unpackSnapshot(packSnapshot(store, intake, info)!);
    // eine Ziehung, die beim Ablegen noch offen war, bekommt jetzt ihre Zerlegung
    const slot = (() => {
      for (let i = 0; i < back.store.n; i++) if (back.store.kind[i] === KIND_OPEN) return i;
      return -1;
    })();
    expect(slot).toBeGreaterThanOrEqual(0);
    const tx = opens.find((o) => Date.parse(o.createdAt!) === back.store.at[slot] && back.store.combo[slot] === back.store.dict.comboOf(back.store.dict.codeOf(o.item!.code!), o.item!.skills))!;
    const before = back.intake.open;
    const matched = back.intake.addScraps([{ _id: 'late', transactionType: 'dismantleItem', buyerId: ME, createdAt: iso(T0 + 9e8), quantity: 54, item: { _id: tx.item!._id } }]);
    expect(matched).toBe(1);
    expect(back.store.kind[slot]).toBe(KIND_SCRAP);
    expect(back.store.amount[slot]).toBe(54);
    expect(back.intake.open).toBe(before - 1);
  });

  it('ordnet späte Verkäufe über Kombination und Erwerbszeit zu und zählt gelesene nicht doppelt', () => {
    const { store, intake, sales } = session(2000, 6);
    const back = unpackSnapshot(packSnapshot(store, intake, info)!);
    // schon verarbeitete Verkäufe noch einmal zu lesen ändert nichts
    const kinds = () => Array.from({ length: back.store.n }, (_, i) => back.store.kind[i]);
    const before = kinds();
    expect(back.intake.addSales(sales)).toBe(0);
    expect(kinds()).toEqual(before);
    expect(back.intake.pending.sales).toBeGreaterThanOrEqual(0);
  });

  it('findet für einen neuen Verkauf eine noch offene Ziehung', () => {
    const { store, intake, opens } = session(2000, 8);
    const back = unpackSnapshot(packSnapshot(store, intake, info)!);
    // eine offene Ziehung mit Erwerbszeit suchen und ihren Verkauf nachreichen
    let target = -1;
    for (let i = 0; i < back.store.n && target < 0; i++) if (back.store.kind[i] === KIND_OPEN && back.store.acqOf(i) !== undefined) target = i;
    expect(target).toBeGreaterThanOrEqual(0);
    const o = opens.find((x) => Date.parse(x.createdAt!) === back.store.at[target] && x.item!.lastAcquisitionAt && Date.parse(x.item!.lastAcquisitionAt) === back.store.acqOf(target))!;
    const sale: SaleTx = { _id: 'fresh-sale', transactionType: 'itemMarket', sellerId: ME, createdAt: iso(T0 + 9e8), money: 12.5, item: { _id: 'bought', code: o.item!.code, skills: o.item!.skills, lastAcquisitionAt: o.item!.lastAcquisitionAt } };
    expect(back.intake.addSales([sale])).toBe(1);
    expect(back.store.kind[target]).toBe(KIND_SOLD);
    expect(back.store.amount[target]).toBeCloseTo(12.5);
  });
});

describe('Zwischenspeicher: beschädigte Daten', () => {
  it('weist fremde, abgeschnittene und verfälschte Daten ab, statt etwas Falsches zu liefern', async () => {
    const { store, intake } = session(800, 9);
    const good = (await encodeSnapshot(store, intake, info))!;
    await expect(decodeSnapshot(new Uint8Array([1, 2, 3, 4, 5, 6]))).rejects.toThrow();
    await expect(decodeSnapshot(new Uint8Array(0))).rejects.toThrow();
    await expect(decodeSnapshot(good.subarray(0, 40))).rejects.toThrow();
    await expect(decodeSnapshot(good.subarray(0, Math.floor(good.length / 2)))).rejects.toThrow();
    // eine unbekannte Version: im Kopf die Versionsziffer um eins erhöhen, sonst bleibt alles gleich
    const raw = packSnapshot(store, intake, info)!;
    const needle = new TextEncoder().encode(`"v":${SNAPSHOT_VERSION}`);
    let found = -1;
    for (let i = 0; i < 600 && found < 0; i++) if (needle.every((b, k) => raw[i + k] === b)) found = i;
    expect(found).toBeGreaterThanOrEqual(0);
    const forged = new Uint8Array(4 + raw.length);
    forged.set([0x57, 0x43, 0x53, 0], 0);
    forged.set(raw, 4);
    forged[4 + found + needle.length - 1] += 1;
    // unverändert ist derselbe Weg lesbar
    const same = new Uint8Array(forged);
    same[4 + found + needle.length - 1] -= 1;
    await expect(decodeSnapshot(same)).resolves.toBeTruthy();
    await expect(decodeSnapshot(forged)).rejects.toThrow();
  });
});
