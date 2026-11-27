import { describe, it, expect } from 'vitest';
import { Intake, type OpenTx, type SaleTx, type ScrapTx } from '../src/cases/intake';
import { PullStore, KIND_OPEN, KIND_SCRAP, KIND_SOLD, NO_ACQ, dayIndex } from '../src/cases/store';

const ME = 'me';
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);
let seq = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const hex = (n: number) => n.toString(16).padStart(24, '0');

interface Spec {
  code?: string;
  skills?: Record<string, number>;
  at?: number;
  acq?: number | null;
  caseCode?: string;
}

/** Eine Öffnung wie aus der API; die Erwerbszeit liegt wenige ms vor der Transaktion. */
function open(spec: Spec = {}): OpenTx & { _itemId: string; _acq: number | null; _at: number } {
  const n = ++seq;
  const at = spec.at ?? T0 + n * 40;
  const acq = spec.acq === undefined ? at - 5 : spec.acq;
  return {
    _id: hex(0x6b0000 + n),
    transactionType: 'openCase',
    itemCode: spec.caseCode ?? 'case1',
    buyerId: ME,
    sellerId: ME,
    createdAt: iso(at),
    item: {
      _id: hex(0x7c0000 + n),
      code: spec.code ?? 'chest2',
      skills: spec.skills ?? { armor: 9 },
      ...(acq === null ? {} : { lastAcquisitionAt: iso(acq) }),
    },
    _itemId: hex(0x7c0000 + n),
    _acq: acq,
    _at: at,
  };
}

const scrap = (o: { _itemId: string }, quantity = 18, at = T0 + 60_000, over: Partial<ScrapTx> = {}): ScrapTx => ({
  _id: `d-${o._itemId}`,
  transactionType: 'dismantleItem',
  buyerId: ME,
  createdAt: iso(at),
  quantity,
  item: { _id: o._itemId },
  ...over,
});

let saleSeq = 0;
const sale = (o: { _acq: number | null; item?: OpenTx['item'] }, money: number, over: Partial<SaleTx> = {}, acqShift = 0): SaleTx => ({
  _id: hex(0x9a0000 + ++saleSeq),
  transactionType: 'itemMarket',
  sellerId: ME,
  createdAt: iso(T0 + 3_600_000),
  money,
  item: { _id: hex(0x8b0000 + saleSeq), code: o.item?.code, skills: o.item?.skills, lastAcquisitionAt: o._acq === null ? undefined : iso(o._acq + acqShift) },
  ...over,
});

const fresh = () => {
  const store = new PullStore(16);
  return { store, intake: new Intake(store, ME) };
};

describe('Intake.addOpen', () => {
  it('legt Ziehungen mit Zeit, Erwerbsabstand, Kistenart, Kombination und Preis an', () => {
    const { store, intake } = fresh();
    const o = open({ code: 'boots5', skills: { dodge: 33 }, caseCode: 'case2' });
    const slot = intake.addOpen(o, 31.5);
    expect(slot).toBe(0);
    expect(store.at[0]).toBe(o._at);
    expect(store.acqOf(0)).toBe(o._at - 5);
    expect(store.kase[0]).toBe(1);
    expect(store.cost[0]).toBeCloseTo(31.5);
    expect(store.dict.codes[store.dict.comboCode[store.combo[0]]]).toBe('boots5');
    expect(store.dict.skillsOf(store.combo[0])).toEqual({ dodge: 33 });
    expect(store.counts).toEqual([0, 1]);
    expect(intake.open).toBe(1);
  });

  it('übergeht Holzkisten, Werkzeugkästen, fremde Spieler und andere Transaktionen', () => {
    const { store, intake } = fresh();
    expect(intake.addOpen({ ...open(), itemCode: 'toolbox' }, NaN)).toBe(-1);
    expect(intake.addOpen({ ...open(), itemCode: 'woodenCase' }, NaN)).toBe(-1);
    expect(intake.addOpen({ ...open(), buyerId: 'x', sellerId: 'x' }, NaN)).toBe(-1);
    expect(intake.addOpen({ ...open(), transactionType: 'trading' }, NaN)).toBe(-1);
    expect(intake.addOpen({ ...open(), createdAt: 'kaputt' }, NaN)).toBe(-1);
    expect(intake.addOpen({ ...open(), item: null }, NaN)).toBe(-1);
    expect(intake.addOpen({ ...open(), _id: undefined }, NaN)).toBe(-1);
    expect(store.n).toBe(0);
  });

  it('kommt ohne Erwerbszeit zurecht: die Ziehung bleibt für Zerlegungen auffindbar', () => {
    const { store, intake } = fresh();
    const o = open({ acq: null });
    intake.addOpen(o, NaN);
    expect(store.acqDelta[0]).toBe(NO_ACQ);
    expect(store.acqOf(0)).toBeUndefined();
    expect(intake.addScraps([scrap(o)])).toBe(1);
    expect(store.kind[0]).toBe(KIND_SCRAP);
  });
});

describe('Intake: Zerlegungen', () => {
  it('ordnet eine Zerlegung zu, wenn die Ziehung zuerst da war', () => {
    const { store, intake } = fresh();
    const o = open();
    intake.addOpen(o, NaN);
    expect(intake.open).toBe(1);
    expect(intake.addScraps([scrap(o, 18, T0 + 60_000)])).toBe(1);
    expect(store.kind[0]).toBe(KIND_SCRAP);
    expect(store.amount[0]).toBe(18);
    expect(store.oday[0]).toBe(dayIndex(T0 + 60_000));
    expect(intake.open).toBe(0);
  });

  it('merkt sich eine Zerlegung, deren Ziehung erst später geladen wird', () => {
    const { store, intake } = fresh();
    const o = open();
    expect(intake.addScraps([scrap(o, 54)])).toBe(0);
    expect(intake.pending.scraps).toBe(1);
    intake.addOpen(o, NaN);
    expect(store.kind[0]).toBe(KIND_SCRAP);
    expect(store.amount[0]).toBe(54);
    expect(intake.open).toBe(0);
    expect(intake.pending.scraps).toBe(0);
  });

  it('zählt eine erneut gelesene Zerlegung nicht doppelt und lässt nichts anwachsen', () => {
    const { store, intake } = fresh();
    const a = open();
    const b = open();
    intake.addOpen(a, NaN);
    const dismantles = [scrap(a), scrap(b)];
    expect(intake.addScraps(dismantles)).toBe(1);
    for (let i = 0; i < 5; i++) expect(intake.addScraps(dismantles)).toBe(0);
    expect(intake.pending.scraps).toBe(2); // eine für b, eine veraltete für a; wächst bei erneutem Lesen nicht weiter
    intake.addOpen(b, NaN);
    expect(store.kind[1]).toBe(KIND_SCRAP);
  });

  it('ignoriert fremde und andersartige Transaktionen', () => {
    const { store, intake } = fresh();
    const o = open();
    intake.addOpen(o, NaN);
    expect(intake.addScraps([scrap(o, 18, T0, { buyerId: 'other' })])).toBe(0);
    expect(intake.addScraps([scrap(o, 18, T0, { transactionType: 'itemMarket' })])).toBe(0);
    expect(intake.addScraps([scrap(o, 18, T0, { item: null })])).toBe(0);
    expect(store.kind[0]).toBe(KIND_OPEN);
    expect(intake.open).toBe(1);
  });
});

describe('Intake: Verkäufe', () => {
  it('erkennt einen Verkauf an Code, Werten und exakter Erwerbszeit', () => {
    const { store, intake } = fresh();
    const a = open({ code: 'boots4', skills: { dodge: 23 } });
    const b = open({ code: 'boots4', skills: { dodge: 25 } });
    intake.addOpen(a, NaN);
    intake.addOpen(b, NaN);
    expect(intake.addSales([sale({ ...a, item: a.item }, 61.5)])).toBe(1);
    expect(store.kind[0]).toBe(KIND_SOLD);
    expect(store.amount[0]).toBeCloseTo(61.5);
    expect(store.kind[1]).toBe(KIND_OPEN);
    expect(intake.open).toBe(1);
  });

  it('lässt einen Verkauf mit anderen Werten, anderem Code oder fremder Erwerbszeit unbeachtet', () => {
    const { store, intake } = fresh();
    const p = open({ code: 'boots4', skills: { dodge: 23 } });
    intake.addOpen(p, NaN);
    expect(intake.addSales([sale({ _acq: p._acq, item: { code: 'boots4', skills: { dodge: 24 } } }, 10)])).toBe(0);
    expect(intake.addSales([sale({ _acq: p._acq, item: { code: 'boots5', skills: { dodge: 23 } } }, 10)])).toBe(0);
    expect(intake.addSales([sale(p, 10, {}, 1)])).toBe(0); // schon eine Millisekunde daneben ist ein anderes Item
    expect(intake.addSales([sale(p, 10, {}, -30 * 24 * 3_600_000)])).toBe(0);
    expect(store.kind[0]).toBe(KIND_OPEN);
    expect(intake.open).toBe(1);
  });

  it('übergeht Verkäufe anderer, Käufe, andere Arten und Einträge ohne Erwerbszeit', () => {
    const { store, intake } = fresh();
    const p = open();
    intake.addOpen(p, NaN);
    expect(intake.addSales([sale(p, 10, { sellerId: 'other' })])).toBe(0);
    expect(intake.addSales([sale(p, 10, { transactionType: 'trading' })])).toBe(0);
    expect(intake.addSales([sale({ _acq: null, item: p.item }, 10)])).toBe(0);
    expect(intake.addSales([sale(p, 10, { createdAt: 'kaputt' })])).toBe(0);
    expect(store.kind[0]).toBe(KIND_OPEN);
    expect(intake.pending.sales).toBe(0);
  });

  it('merkt sich einen Verkauf, dessen Ziehung erst später geladen wird', () => {
    const { store, intake } = fresh();
    const p = open({ code: 'jet', skills: { attack: 272, criticalChance: 47 } });
    expect(intake.addSales([sale(p, 505.5)])).toBe(0);
    expect(intake.pending.sales).toBe(1);
    intake.addOpen(p, NaN);
    expect(store.kind[0]).toBe(KIND_SOLD);
    expect(store.amount[0]).toBeCloseTo(505.5);
    expect(intake.open).toBe(0);
    expect(intake.pending.sales).toBe(0);
  });

  it('weist gleiche Items einzeln zu und zählt eine erneut gelesene Transaktion nicht doppelt', () => {
    const { store, intake } = fresh();
    const a = open({ code: 'chest1', skills: { armor: 2 } });
    const b = open({ code: 'chest1', skills: { armor: 2 }, at: a._at, acq: a._acq });
    intake.addOpen(a, NaN);
    intake.addOpen(b, NaN);
    const s1 = sale(a, 3.2);
    expect(intake.addSales([s1])).toBe(1);
    expect(intake.addSales([s1])).toBe(0);
    expect(intake.addSales([sale(a, 3.4)])).toBe(1);
    expect([store.kind[0], store.kind[1]]).toEqual([KIND_SOLD, KIND_SOLD]);
    // ein dritter Verkauf findet nichts mehr und wartet auf eine Ziehung
    expect(intake.addSales([sale(a, 3.0)])).toBe(0);
    expect(intake.pending.sales).toBe(1);
  });

  it('ordnet eine über die Zerlegung zugeordnete Ziehung nicht noch einmal einem gleichen Verkauf zu', () => {
    const { store, intake } = fresh();
    const a = open({ code: 'chest1', skills: { armor: 2 } });
    intake.addOpen(a, NaN);
    expect(intake.addScraps([scrap(a)])).toBe(1);
    // ein gleicher Verkauf (etwa eines selbst gekauften, identischen Items) trifft die zerlegte Ziehung nicht
    expect(intake.addSales([sale(a, 3.2)])).toBe(0);
    expect(store.kind[0]).toBe(KIND_SCRAP);
    expect(intake.open).toBe(0);
  });

  it('gibt der Zerlegung (eindeutige Item-ID) den Vorrang vor einem Verkauf gleichen Schlüssels', () => {
    const { store, intake } = fresh();
    const a = open();
    intake.addOpen(a, NaN);
    expect(intake.addSales([sale(a, 7)])).toBe(1);
    expect(store.kind[0]).toBe(KIND_SOLD);
    // Die Zerlegung gehört zu dieser Ziehung; der Verkauf muss also von einem anderen Item stammen und wartet
    expect(intake.addScraps([scrap(a, 18)])).toBe(0);
    expect(store.kind[0]).toBe(KIND_SCRAP);
    expect(store.amount[0]).toBe(18);
    expect(intake.open).toBe(0);
    expect(intake.pending.sales).toBe(1);
    // und findet eine später geladene gleichwertige Ziehung
    const twin = open({ at: a._at, acq: a._acq });
    intake.addOpen(twin, NaN);
    expect(store.kind[1]).toBe(KIND_SOLD);
    expect(store.amount[1]).toBeCloseTo(7);
    expect(intake.pending.sales).toBe(0);
    expect(intake.open).toBe(0);
  });

  it('lässt einen Verkauf zu einem gleichwertigen Zwilling umziehen, wenn die Zerlegung später eintrifft', () => {
    const { store, intake } = fresh();
    const a = open({ code: 'chest1', skills: { armor: 2 } });
    const b = open({ code: 'chest1', skills: { armor: 2 }, at: a._at, acq: a._acq });
    intake.addOpen(a, NaN);
    intake.addOpen(b, NaN);
    // der Verkauf nimmt die erste passende Ziehung, hier a; tatsächlich verkauft war b, a wurde zerlegt
    expect(intake.addSales([sale(b, 3.2)])).toBe(1);
    expect([store.kind[0], store.kind[1]]).toEqual([KIND_SOLD, KIND_OPEN]);
    expect(intake.addScraps([scrap(a, 18)])).toBe(1);
    expect([store.kind[0], store.kind[1]]).toEqual([KIND_SCRAP, KIND_SOLD]);
    expect(store.amount[0]).toBe(18);
    expect(store.amount[1]).toBeCloseTo(3.2);
    expect(intake.open).toBe(0);
    expect(intake.pending.sales).toBe(0);
  });

  it('endet bei gleichwertigen Ziehungen in jeder Ankunftsreihenfolge gleich', () => {
    // 6 gleichwertige Ziehungen, 2 davon verkauft, 4 zerlegt: Welche genau verkauft wurden, lässt sich nicht erkennen, aber die
    // Zerlegungen stehen fest. Unabhängig von der Reihenfolge müssen am Ende 4 zerlegt, 2 verkauft und keine offen sein, und es
    // darf nichts Verwaistes zurückbleiben (auch nicht, wenn ein wartender Verkauf gleich der ersten geladenen Ziehung zufällt).
    const orders = [
      ['open', 'sale', 'scrap'],
      ['sale', 'open', 'scrap'],
      ['scrap', 'sale', 'open'],
      ['sale', 'scrap', 'open'],
      ['scrap', 'open', 'sale'],
      ['open', 'scrap', 'sale'],
    ] as const;
    const scrapped = [[2, 3, 4, 5], [0, 1, 2, 3], [0, 2, 3, 5], [1, 2, 4, 5]];
    for (const set of scrapped) {
      for (const order of orders) {
        const { store, intake } = fresh();
        const items = Array.from({ length: 6 }, () => open({ code: 'chest1', skills: { armor: 2 }, at: T0 + 1000, acq: T0 + 995 }));
        const sales = [sale(items[0], 3.1), sale(items[0], 3.3)];
        const scraps = set.map((i) => scrap(items[i], 18));
        for (const step of order) {
          if (step === 'open') for (const o of items) intake.addOpen(o, NaN);
          if (step === 'sale') intake.addSales(sales);
          if (step === 'scrap') intake.addScraps(scraps);
        }
        const k = (x: number) => Array.from({ length: store.n }, (_, i) => store.kind[i]).filter((v) => v === x).length;
        const label = `${set.join('')} ${order.join()}`;
        expect({ label, scrapped: k(KIND_SCRAP), sold: k(KIND_SOLD), open: k(KIND_OPEN) }).toEqual({ label, scrapped: 4, sold: 2, open: 0 });
        expect({ label, open: intake.open, pending: intake.pending }).toEqual({ label, open: 0, pending: { scraps: 0, sales: 0 } });
        // die Zerlegten sind genau die mit Zerlegung
        for (const i of set) expect(store.kind[i]).toBe(KIND_SCRAP);
      }
    }
  });
});

describe('Intake: Menge', () => {
  it('ordnet hunderttausende Ziehungen in beliebiger Ankunftsreihenfolge ohne quadratischen Aufwand zu', () => {
    const N = 300_000;
    const codes = ['chest1', 'chest2', 'gloves1', 'boots2', 'helmet1', 'pants2'];
    const opens: ReturnType<typeof open>[] = [];
    for (let i = 0; i < N; i++) {
      const at = T0 + i * 7;
      opens.push({
        _id: hex(0x100000 + i),
        transactionType: 'openCase',
        itemCode: 'case1',
        buyerId: ME,
        sellerId: ME,
        createdAt: iso(at),
        item: { _id: hex(0x500000 + i), code: codes[i % codes.length], skills: { armor: 1 + (i % 3) }, lastAcquisitionAt: iso(at - 3) },
        _itemId: hex(0x500000 + i),
        _acq: at - 3,
        _at: at,
      });
    }
    const scraps: ScrapTx[] = [];
    const sales: SaleTx[] = [];
    opens.forEach((o, i) => {
      if (i % 50 === 0) sales.push(sale(o, 2));
      else scraps.push(scrap(o, 6));
    });

    const { store, intake } = fresh();
    const started = performance.now();
    // Ergebnisse zuerst, Ziehungen in Seiten von neu nach alt: so kommen sie beim Nachladen an
    for (let i = 0; i < scraps.length; i += 1000) intake.addScraps(scraps.slice(i, i + 1000));
    for (let i = 0; i < sales.length; i += 1000) intake.addSales(sales.slice(i, i + 1000));
    for (let end = N; end > 0; end -= 100) for (let i = Math.min(end, N) - 1; i >= Math.max(0, end - 100); i--) intake.addOpen(opens[i], NaN);
    const elapsed = performance.now() - started;

    expect(store.n).toBe(N);
    expect(intake.open).toBe(0);
    let scrapped = 0;
    let sold = 0;
    for (let i = 0; i < N; i++) {
      if (store.kind[i] === KIND_SCRAP) scrapped++;
      else if (store.kind[i] === KIND_SOLD) sold++;
    }
    expect(sold).toBe(N / 50);
    expect(scrapped).toBe(N - N / 50);
    expect(intake.pending).toEqual({ scraps: 0, sales: 0 });
    expect(elapsed).toBeLessThan(8000);
  }, 30_000);

  it('hält Ziehungen und Ergebnisse in umgekehrter Reihenfolge ebenso zusammen', () => {
    const { store, intake } = fresh();
    const opens = Array.from({ length: 2000 }, (_, i) => open({ skills: { armor: 1 + (i % 4) } }));
    for (const o of opens) intake.addOpen(o, NaN);
    expect(intake.open).toBe(2000);
    const half = opens.slice(0, 1000);
    intake.addScraps(half.map((o) => scrap(o)));
    intake.addSales(opens.slice(1000, 1100).map((o) => sale(o, 5)));
    expect(intake.open).toBe(900);
    for (let i = 0; i < 1000; i++) expect(store.kind[i]).toBe(KIND_SCRAP);
    for (let i = 1000; i < 1100; i++) expect(store.kind[i]).toBe(KIND_SOLD);
  });
});
