import { describe, it, expect } from 'vitest';
import { OutcomeMatcher, itemSignature, matchOutcomes } from '../src/cases/outcomes';
import type { DismantleTx, MarketTx, Pull } from '../src/cases/logic';

const ME = 'me';
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);
let seq = 0;

/** Eine Ziehung mit gemessener Erwerbszeit, wie sie aus der API kommt (wenige ms vor der Transaktion). */
const pull = (over: Partial<Pull> = {}): Pull => {
  const n = ++seq;
  const at = T0 + n * 40;
  return {
    id: `p${n}`,
    itemId: `i${n}`,
    at: new Date(at).toISOString(),
    acq: at - 5,
    caseCode: 'case1',
    itemCode: 'chest2',
    rarity: 'uncommon',
    skills: { armor: 9 },
    cost: null,
    ...over,
  };
};

const iso = (ms: number) => new Date(ms).toISOString();

const scrap = (p: Pull, quantity = 18, at = T0 + 60_000): DismantleTx => ({
  _id: `d-${p.itemId}`,
  transactionType: 'dismantleItem',
  buyerId: ME,
  createdAt: iso(at),
  quantity,
  item: { _id: p.itemId },
});

let saleSeq = 0;
const sale = (p: Pick<Pull, 'itemCode' | 'skills'> & { acq?: number; at: string }, money: number, over: Partial<MarketTx> = {}, acqShift = 0): MarketTx => ({
  _id: `s${++saleSeq}`,
  transactionType: 'itemMarket',
  sellerId: ME,
  buyerId: 'someone',
  createdAt: iso(T0 + 3_600_000),
  money,
  item: { _id: `new${saleSeq}`, code: p.itemCode, skills: p.skills, lastAcquisitionAt: iso((p.acq ?? Date.parse(p.at)) + acqShift) },
  ...over,
});

describe('itemSignature', () => {
  it('ist von der Reihenfolge der Werte unabhängig und trennt Codes und Werte', () => {
    expect(itemSignature('rifle', { attack: 80, criticalChance: 12 })).toBe(itemSignature('rifle', { criticalChance: 12, attack: 80 }));
    expect(itemSignature('rifle', { attack: 80 })).not.toBe(itemSignature('rifle', { attack: 81 }));
    expect(itemSignature('boots4', { dodge: 23 })).not.toBe(itemSignature('boots5', { dodge: 23 }));
    expect(itemSignature('knife', undefined)).toBe('knife');
  });
});

describe('OutcomeMatcher: Zerlegungen', () => {
  it('ordnet eine Zerlegung zu, wenn die Ziehung zuerst da war', () => {
    const m = new OutcomeMatcher(ME);
    const p = pull();
    expect(m.addPulls([p])).toEqual({});
    expect(m.open).toBe(1);
    expect(m.addScraps([scrap(p, 18)])).toEqual({ [p.id]: { kind: 'scrapped', at: iso(T0 + 60_000), amount: 18 } });
    expect(m.open).toBe(0);
  });

  it('merkt sich eine Zerlegung, deren Ziehung erst später geladen wird', () => {
    const m = new OutcomeMatcher(ME);
    const p = pull();
    expect(m.addScraps([scrap(p, 54)])).toEqual({});
    expect(m.addPulls([p])).toEqual({ [p.id]: { kind: 'scrapped', at: iso(T0 + 60_000), amount: 54 } });
    expect(m.open).toBe(0);
  });

  it('zählt eine erneut gelesene Zerlegung nicht doppelt und ignoriert fremde', () => {
    const m = new OutcomeMatcher(ME);
    const p = pull();
    const d = scrap(p);
    m.addPulls([p]);
    expect(Object.keys(m.addScraps([d]))).toHaveLength(1);
    expect(m.addScraps([d])).toEqual({});
    const q = pull();
    m.addPulls([q]);
    expect(m.addScraps([{ ...scrap(q), buyerId: 'other' }])).toEqual({});
    expect(m.addScraps([{ ...scrap(q), transactionType: 'itemMarket' }])).toEqual({});
    expect(m.open).toBe(1);
  });
});

describe('OutcomeMatcher: Verkäufe', () => {
  it('erkennt einen Verkauf an Code, Werten und exakter Erwerbszeit', () => {
    const m = new OutcomeMatcher(ME);
    const a = pull({ itemCode: 'boots4', skills: { dodge: 23 } });
    const b = pull({ itemCode: 'boots4', skills: { dodge: 25 } });
    m.addPulls([a, b]);
    const found = m.addSales([sale(a, 61.5)]);
    expect(found).toEqual({ [a.id]: { kind: 'sold', at: iso(T0 + 3_600_000), amount: 61.5 } });
    expect(m.open).toBe(1);
  });

  it('lässt einen Verkauf mit anderen Werten, anderem Code oder fremder Erwerbszeit unbeachtet', () => {
    const m = new OutcomeMatcher(ME);
    const p = pull({ itemCode: 'boots4', skills: { dodge: 23 } });
    m.addPulls([p]);
    expect(m.addSales([sale({ ...p, skills: { dodge: 24 } }, 10)])).toEqual({});
    expect(m.addSales([sale({ ...p, itemCode: 'boots5' }, 10)])).toEqual({});
    expect(m.addSales([sale(p, 10, {}, 5_000)])).toEqual({});
    // selbst gekauft und weiterverkauft: gleiche Werte, aber ganz andere Erwerbszeit
    expect(m.addSales([sale(p, 10, {}, -30 * 24 * 3_600_000)])).toEqual({});
    expect(m.open).toBe(1);
  });

  it('übergeht Verkäufe anderer, Käufe und Einträge ohne Erwerbszeit', () => {
    const m = new OutcomeMatcher(ME);
    const p = pull();
    m.addPulls([p]);
    expect(m.addSales([sale(p, 10, { sellerId: 'other' })])).toEqual({});
    expect(m.addSales([sale(p, 10, { sellerId: 'other', buyerId: ME })])).toEqual({});
    const noAcq = sale(p, 10);
    noAcq.item = { ...noAcq.item, lastAcquisitionAt: undefined };
    expect(m.addSales([noAcq])).toEqual({});
    expect(m.addSales([sale(p, 10, { transactionType: 'trading' })])).toEqual({});
    expect(m.open).toBe(1);
  });

  it('merkt sich einen Verkauf, dessen Ziehung erst später geladen wird', () => {
    const m = new OutcomeMatcher(ME);
    const p = pull({ itemCode: 'jet', skills: { attack: 272, criticalChance: 47 } });
    expect(m.addSales([sale(p, 505.5)])).toEqual({});
    expect(m.addPulls([p])).toEqual({ [p.id]: { kind: 'sold', at: iso(T0 + 3_600_000), amount: 505.5 } });
    expect(m.open).toBe(0);
  });

  it('weist gleiche Items einzeln zu und zählt eine erneut gelesene Transaktion nicht doppelt', () => {
    const m = new OutcomeMatcher(ME);
    const a = pull({ itemCode: 'chest1', skills: { armor: 2 } });
    const b = pull({ itemCode: 'chest1', skills: { armor: 2 }, acq: a.acq, at: a.at });
    m.addPulls([a, b]);
    const s1 = sale(a, 3.2);
    const first = m.addSales([s1]);
    expect(Object.keys(first)).toHaveLength(1);
    expect(m.addSales([s1])).toEqual({});
    const second = m.addSales([sale(a, 3.4)]);
    expect(Object.keys(second)).toHaveLength(1);
    expect(new Set([...Object.keys(first), ...Object.keys(second)])).toEqual(new Set([a.id, b.id]));
    // ein dritter Verkauf findet nichts mehr und wartet auf eine Ziehung
    expect(m.addSales([sale(a, 3.0)])).toEqual({});
  });

  it('nimmt bei mehreren Treffern die zeitlich nächste Ziehung', () => {
    const m = new OutcomeMatcher(ME);
    const base = { itemCode: 'gloves2', skills: { precision: 10 } };
    const far = pull({ ...base, acq: T0 + 1000, at: iso(T0 + 1005) });
    const near = pull({ ...base, acq: T0 + 1020, at: iso(T0 + 1025) });
    m.addPulls([far, near]);
    // beide liegen innerhalb weniger ms Spielraum, der Verkauf trägt aber genau die Erwerbszeit von `near`
    const found = m.addSales([sale({ ...base, acq: near.acq, at: near.at }, 5)]);
    expect(Object.keys(found)).toEqual([near.id]);
    // der nächste gleiche Verkauf bekommt die verbleibende Ziehung
    expect(Object.keys(m.addSales([sale({ ...base, acq: near.acq, at: near.at }, 6)]))).toEqual([far.id]);
  });

  it('gleicht alte gespeicherte Ziehungen ohne Erwerbszeit mit zwei Sekunden Spielraum ab', () => {
    const m = new OutcomeMatcher(ME);
    const old = pull({ itemCode: 'boots4', skills: { dodge: 25 } });
    delete old.acq;
    m.addPulls([old]);
    expect(m.addSales([sale(old, 61.5, {}, -3)])).toEqual({ [old.id]: { kind: 'sold', at: iso(T0 + 3_600_000), amount: 61.5 } });

    const other = pull({ itemCode: 'boots4', skills: { dodge: 26 } });
    delete other.acq;
    m.addPulls([other]);
    expect(m.addSales([sale(other, 9, {}, -2500)])).toEqual({});
  });

  it('übernimmt schon bekannte Ergebnisse, ohne die Ziehung erneut zuzuordnen', () => {
    const m = new OutcomeMatcher(ME);
    const p = pull();
    const done = { [p.id]: { kind: 'scrapped' as const, at: iso(T0), amount: 18 } };
    expect(m.addPulls([p], done)).toEqual({});
    expect(m.open).toBe(0);
    expect(m.addSales([sale(p, 99)])).toEqual({});
  });
});

describe('matchOutcomes', () => {
  it('ordnet eine fertige Menge zu: Zerlegung geht vor Verkauf', () => {
    const a = pull({ itemCode: 'rifle', skills: { attack: 80, criticalChance: 12 } });
    const b = pull({ itemCode: 'boots4', skills: { dodge: 23 } });
    const out = matchOutcomes([a, b], ME, [scrap(a, 54)], [sale(b, 40), sale(a, 70)]);
    expect(out[a.id].kind).toBe('scrapped');
    expect(out[b.id]).toEqual({ kind: 'sold', at: iso(T0 + 3_600_000), amount: 40 });
  });
});

describe('OutcomeMatcher: Menge', () => {
  it('ordnet zehntausende Ziehungen in beliebiger Ankunftsreihenfolge ohne quadratischen Aufwand zu', () => {
    const N = 30_000;
    const codes = ['chest1', 'chest2', 'gloves1', 'boots2', 'helmet1', 'pants2'];
    const pulls: Pull[] = [];
    for (let i = 0; i < N; i++) {
      const at = T0 + i * 7;
      pulls.push({
        id: `P${i}`,
        itemId: `I${i}`,
        at: iso(at),
        acq: at - 3,
        caseCode: 'case1',
        itemCode: codes[i % codes.length],
        rarity: 'common',
        skills: { armor: 1 + (i % 3) },
        cost: null,
      });
    }
    const scrapped = pulls.filter((_, i) => i % 50 !== 0);
    const sold = pulls.filter((_, i) => i % 50 === 0);
    const dismantles = scrapped.map((p) => scrap(p, 6));
    const sales = sold.map((p) => sale(p, 2));

    const started = Date.now();
    const m = new OutcomeMatcher(ME);
    const found: Record<string, unknown> = {};
    // Ergebnisse zuerst, Ziehungen in Seiten von neu nach alt: so kommen sie beim Nachladen an
    Object.assign(found, m.addScraps(dismantles), m.addSales(sales));
    for (let end = N; end > 0; end -= 100) Object.assign(found, m.addPulls(pulls.slice(Math.max(0, end - 100), end).reverse()));
    const elapsed = Date.now() - started;

    expect(Object.keys(found)).toHaveLength(N);
    expect(m.open).toBe(0);
    expect(elapsed).toBeLessThan(4000);
  });
});
