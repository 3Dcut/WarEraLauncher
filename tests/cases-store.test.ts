import { describe, it, expect } from 'vitest';
import { IdHash, ItemDict, PullStore, NO_ACQ, KIND_SCRAP, dayIndex, dayStartMs, hash3, idWords, mergeOrder } from '../src/cases/store';
import { rng } from '../src/cases/logic';

const words = (id: string) => {
  const w = new Int32Array(3);
  idWords(id, w);
  return [w[0], w[1], w[2]] as const;
};

describe('idWords', () => {
  it('zerlegt eine ObjectId verlustfrei in drei Wörter, unabhängig von der Schreibweise', () => {
    const [a, b, c] = words('6b097c28d1a641f847674a3e');
    expect(a >>> 0).toBe(0x6b097c28);
    expect(b >>> 0).toBe(0xd1a641f8);
    expect(c >>> 0).toBe(0x47674a3e);
    expect(words('6B097C28D1A641F847674A3E')).toEqual([a, b, c]);
  });

  it('hasht anderen Text deterministisch und unterscheidbar', () => {
    expect(words('item-1')).toEqual(words('item-1'));
    expect(words('item-1')).not.toEqual(words('item-2'));
    expect(words('')).toEqual(words(''));
    // 24 Zeichen, aber nicht hexadezimal
    expect(words('zzzzzzzzzzzzzzzzzzzzzzzz')).not.toEqual(words('yyyyyyyyyyyyyyyyyyyyyyyy'));
  });

  it('verteilt aufeinanderfolgende ObjectIds gleichmäßig auf die Hash-Fächer', () => {
    const buckets = new Uint32Array(1024);
    for (let i = 0; i < 100_000; i++) {
      const id = (0x6b097c28d1a641f8n + BigInt(i)).toString(16).padStart(16, '0') + '47674a3e';
      const [a, b, c] = words(id);
      buckets[hash3(a, b, c) & 1023]++;
    }
    // erwartet gut 97 je Fach; extreme Häufungen würden die Tabelle verlangsamen
    expect(Math.max(...buckets)).toBeLessThan(170);
    expect(Math.min(...buckets)).toBeGreaterThan(40);
  });
});

describe('IdHash', () => {
  it('findet, überschreibt nicht und löscht', () => {
    const h = new IdHash(16);
    const a = h.insert(1, 2, 3, 10);
    h.insert(4, 5, 6, 20);
    expect(h.size).toBe(2);
    expect(h.val[h.find(1, 2, 3)]).toBe(10);
    expect(h.val[h.find(4, 5, 6)]).toBe(20);
    expect(h.find(7, 8, 9)).toBe(-1);
    h.remove(a);
    expect(h.find(1, 2, 3)).toBe(-1);
    expect(h.size).toBe(1);
    h.remove(a); // zweites Löschen ändert nichts
    expect(h.size).toBe(1);
  });

  it('erlaubt gleiche Schlüssel mehrfach und liefert sie nacheinander', () => {
    const h = new IdHash(16);
    h.insert(9, 9, 9, 1);
    h.insert(9, 9, 9, 2);
    h.insert(9, 9, 9, 3);
    const seen: number[] = [];
    for (let b = h.find(9, 9, 9); b >= 0; b = h.find(9, 9, 9)) {
      seen.push(h.val[b]);
      h.remove(b);
    }
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(h.size).toBe(0);
  });

  it('wächst, wirft Grabsteine hinaus und bleibt dabei korrekt', () => {
    const h = new IdHash(16, true);
    const rand = rng(11);
    const keys: [number, number, number][] = [];
    for (let i = 0; i < 60_000; i++) keys.push([(rand() * 2 ** 32) | 0, (rand() * 2 ** 32) | 0, i]);
    keys.forEach((k, i) => h.insert(k[0], k[1], k[2], i, i * 0.5, i % 65535));
    expect(h.size).toBe(60_000);
    // jede zweite entfernen, danach neue einfügen (Grabsteine werden wiederverwendet oder entsorgt)
    keys.forEach((k, i) => {
      if (i % 2 === 0) h.remove(h.find(k[0], k[1], k[2]));
    });
    expect(h.size).toBe(30_000);
    for (let i = 0; i < 30_000; i++) h.insert(i, i, -i - 1, 1000 + i);
    for (let i = 1; i < keys.length; i += 2) {
      const b = h.find(keys[i][0], keys[i][1], keys[i][2]);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(h.val[b]).toBe(i);
      expect(h.amt![b]).toBeCloseTo(i * 0.5, 3);
      expect(h.day![b]).toBe(i % 65535);
    }
    for (let i = 0; i < keys.length; i += 2) expect(h.find(keys[i][0], keys[i][1], keys[i][2])).toBe(-1);
    expect(h.size).toBe(60_000);
  });
});

describe('ItemDict', () => {
  it('vergibt je Code eine Nummer und je Kombination aus Code und Werten eine', () => {
    const d = new ItemDict();
    const chest = d.codeOf('chest2');
    const rifle = d.codeOf('rifle');
    expect(d.codeOf('chest2')).toBe(chest);
    expect(d.codeOf('rifle')).toBe(rifle);
    const a = d.comboOf(chest, { armor: 9 });
    expect(d.comboOf(chest, { armor: 9 })).toBe(a);
    expect(d.comboOf(chest, { armor: 10 })).not.toBe(a);
    expect(d.comboOf(rifle, { armor: 9 })).not.toBe(a);
    expect(d.skillsOf(a)).toEqual({ armor: 9 });
  });

  it('ist von der Reihenfolge der Werte unabhängig', () => {
    const d = new ItemDict();
    const rifle = d.codeOf('rifle');
    const a = d.comboOf(rifle, { attack: 80, criticalChance: 12 });
    expect(d.comboOf(rifle, { criticalChance: 12, attack: 80 })).toBe(a);
    expect(d.skillsOf(a)).toEqual({ attack: 80, criticalChance: 12 });
    expect(d.comboOf(rifle, { attack: 80 })).not.toBe(a);
    expect(d.skillsOf(d.comboOf(rifle, { attack: 80 }))).toEqual({ attack: 80 });
  });

  it('kommt mit Null, fehlenden Werten, Kommazahlen und großen Werten zurecht', () => {
    const d = new ItemDict();
    const c = d.codeOf('x1');
    const none = d.comboOf(c, undefined);
    expect(d.comboOf(c, {})).toBe(none);
    expect(d.skillsOf(none)).toEqual({});
    const zero = d.comboOf(c, { a: 0 });
    expect(zero).not.toBe(none);
    expect(d.skillsOf(zero)).toEqual({ a: 0 });
    const odd = d.comboOf(c, { a: 0.5 });
    expect(d.comboOf(c, { a: 0.5 })).toBe(odd);
    expect(d.skillsOf(odd)).toEqual({ a: 0.5 });
    const big = d.comboOf(c, { a: 70_000 });
    expect(d.skillsOf(big)).toEqual({ a: 70_000 });
    expect(new Set([none, zero, odd, big]).size).toBe(4);
  });

  it('speichert höchstens drei Werte je Code und ignoriert weitere', () => {
    const d = new ItemDict();
    const c = d.codeOf('y');
    const id = d.comboOf(c, { a: 1, b: 2, c: 3, d: 4 });
    expect(d.skillsOf(id)).toEqual({ a: 1, b: 2, c: 3 });
    expect(d.comboOf(c, { a: 1, b: 2, c: 3, e: 9 })).toBe(id);
  });

  it('wächst über die Anfangsgröße hinaus', () => {
    const d = new ItemDict();
    const c = d.codeOf('w');
    const ids = Array.from({ length: 3000 }, (_, i) => d.comboOf(c, { a: i }));
    expect(new Set(ids).size).toBe(3000);
    expect(d.skillsOf(ids[2999])).toEqual({ a: 2999 });
    expect(d.comboCode[ids[2999]]).toBe(c);
  });
});

describe('PullStore', () => {
  it('hängt Ziehungen an, wächst und behält alle Werte', () => {
    const s = new PullStore(4);
    const slots: number[] = [];
    for (let i = 0; i < 5000; i++) slots.push(s.add(1000 + i, i % 2 ? NO_ACQ : 7, (i % 2) as 0 | 1, i % 11, i % 3 ? NaN : 3.5));
    expect(s.n).toBe(5000);
    expect(s.counts).toEqual([2500, 2500]);
    expect(s.at[4999]).toBe(5999);
    expect(s.acqOf(2)).toBe(1002 - 7);
    expect(s.acqOf(3)).toBeUndefined();
    expect(s.combo[4321]).toBe(4321 % 11);
    expect(s.cost[3]).toBeCloseTo(3.5);
    expect(Number.isNaN(s.cost[1])).toBe(true);
    expect(s.kind[10]).toBe(0);
    s.setOutcome(10, KIND_SCRAP, 54, dayIndex(Date.UTC(2026, 10, 27)));
    expect(s.kind[10]).toBe(KIND_SCRAP);
    expect(s.amount[10]).toBe(54);
    expect(dayStartMs(s.oday[10])).toBe(Date.UTC(2026, 10, 27));
  });

  it('veröffentlicht neue Ziehungen in zeitlicher Reihenfolge, auch bei zufälliger Ankunft und gleichen Zeiten', () => {
    const rand = rng(3);
    const s = new PullStore(8);
    for (let round = 0; round < 40; round++) {
      const m = 1 + Math.floor(rand() * 500);
      // Seiten kommen von neu nach alt, mit vielen gleichen Zeitpunkten (Bursts); manchmal völlig durcheinander
      const base = Math.floor(rand() * 400);
      for (let i = 0; i < m; i++) s.add((base + Math.floor(rand() * 60)) * 1000, 3, 0, 0, NaN);
      const added = s.publish();
      expect(added).toBe(m);
      const expected = Array.from({ length: s.n }, (_, i) => i).sort((a, b) => s.at[a] - s.at[b] || a - b);
      expect(Array.from(s.order.subarray(0, s.published))).toEqual(expected);
    }
    expect(s.publish()).toBe(0);
    const span = s.span()!;
    expect(span.first).toBeLessThanOrEqual(span.last);
  });

  it('nimmt bereits sortierte Seiten ohne erneutes Sortieren auf', () => {
    const s = new PullStore(8);
    for (let i = 0; i < 100; i++) s.add(i * 10, 0, 0, 0, NaN);
    s.publish();
    for (let i = 0; i < 100; i++) s.add(5000 + i * 10, 0, 0, 0, NaN);
    s.publish();
    expect(Array.from(s.order.subarray(0, 200))).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('meldet ohne Ziehungen keinen Zeitraum', () => {
    expect(new PullStore().span()).toBeNull();
  });
});

describe('mergeOrder', () => {
  it('stimmt bei vielen Zufallsfällen mit vollständigem Sortieren überein', () => {
    const rand = rng(99);
    for (let round = 0; round < 200; round++) {
      const n = Math.floor(rand() * 200);
      const m = Math.floor(rand() * 60);
      const at = new Float64Array(n + m);
      for (let i = 0; i < n + m; i++) at[i] = Math.floor(rand() * 30);
      const old = Uint32Array.from(Array.from({ length: n }, (_, i) => i).sort((a, b) => at[a] - at[b] || a - b));
      const fresh = Uint32Array.from(Array.from({ length: m }, (_, i) => n + i).sort((a, b) => at[a] - at[b] || a - b));
      const merged = mergeOrder(old, n, fresh, at);
      const expected = Array.from({ length: n + m }, (_, i) => i).sort((a, b) => at[a] - at[b] || a - b);
      expect(Array.from(merged)).toEqual(expected);
    }
  });
});

describe('Tage', () => {
  it('rechnen UTC-Tage hin und zurück', () => {
    const ms = Date.UTC(2026, 10, 27, 15, 30);
    expect(dayStartMs(dayIndex(ms))).toBe(Date.UTC(2026, 10, 27));
    expect(dayIndex(Date.UTC(2020, 0, 1))).toBe(0);
    expect(dayIndex(Date.UTC(1999, 0, 1))).toBe(0); // davor klemmt
  });
});
