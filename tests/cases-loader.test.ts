import { describe, it, expect } from 'vitest';
import { HistoryLoader, type StreamKey } from '../src/cases/loader';
import { RateBudget } from '../src/assist/limiter';
import type { TxQuery } from '../src/assist/api';

const ME = 'me';
const T_NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

interface Tx {
  _id: string;
  createdAt: string;
  transactionType: string;
}

/** Eine Aufzeichnung je Transaktionsart, neueste zuerst, wie sie die API liefert. */
function history(spec: Record<string, { count: number; everyMs: number; startMs?: number }>): Record<string, Tx[]> {
  const out: Record<string, Tx[]> = {};
  for (const [type, { count, everyMs, startMs = T_NOW }] of Object.entries(spec)) {
    out[type] = Array.from({ length: count }, (_, i) => ({ _id: `${type}-${i}`, createdAt: iso(startMs - i * everyMs), transactionType: type }));
  }
  return out;
}

/** Fake-API: Cursor ist der Versatz in der Liste; zählt die Anfragen und kann einmalig scheitern. */
function fakeApi(data: Record<string, Tx[]>) {
  const state = { calls: 0, queries: [] as TxQuery[][], failNext: 0 };
  const fetch = async (queries: TxQuery[]) => {
    state.calls++;
    state.queries.push(queries);
    if (state.failNext > 0) {
      state.failNext--;
      throw new Error('boom');
    }
    return queries.map((q) => {
      const all = data[q.types[0]] ?? [];
      const from = q.cursor ? Number(q.cursor.slice(1)) : 0;
      const limit = q.limit ?? 50;
      const items = all.slice(from, from + limit);
      return { items, nextCursor: from + limit < all.length ? `c${from + limit}` : null };
    });
  };
  return { state, fetch };
}

async function drain(loader: HistoryLoader, maxSteps = 1000) {
  const got: Record<StreamKey, unknown[]> = { open: [], scrap: [], sale: [] };
  let steps = 0;
  while (!loader.done && steps++ < maxSteps) {
    const page = await loader.step();
    for (const k of ['open', 'scrap', 'sale'] as StreamKey[]) got[k].push(...page[k]);
  }
  return { got, steps };
}

describe('HistoryLoader', () => {
  it('liest von neu nach alt in Seiten und hört an der Zeitgrenze auf', async () => {
    // 1 Öffnung je Minute, 250 Stück = gut vier Stunden; Grenze 2 Stunden zurück
    const api = fakeApi(history({ openCase: { count: 250, everyMs: 60_000 } }));
    const since = iso(T_NOW - 2 * 3600_000);
    const loader = new HistoryLoader({ userId: ME, since, streams: ['open'], fetch: api.fetch, pageSize: 100, startedAt: T_NOW });
    const { got } = await drain(loader);
    expect(got.open).toHaveLength(121); // 0 bis 120 Minuten zurück, Grenze eingeschlossen
    expect((got.open[0] as Tx).createdAt).toBe(iso(T_NOW));
    expect((got.open[120] as Tx).createdAt).toBe(since);
    expect(api.state.calls).toBe(2); // die dritte Seite ist unnötig: schon die zweite enthält ältere Einträge
    expect(loader.done).toBe(true);
  });

  it('bündelt alle unfertigen Ströme in einer Anfrage und lässt fertige weg', async () => {
    const api = fakeApi(
      history({
        openCase: { count: 300, everyMs: 1000 },
        dismantleItem: { count: 300, everyMs: 1000 },
        itemMarket: { count: 5, everyMs: 1000 },
      }),
    );
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: api.fetch, pageSize: 100, startedAt: T_NOW });
    const first = await loader.step();
    expect(api.state.queries[0].map((q) => q.types[0])).toEqual(['openCase', 'dismantleItem', 'itemMarket']);
    expect(first.open).toHaveLength(100);
    expect(first.sale).toHaveLength(5);
    expect(loader.state.sale.done).toBe(true);
    await loader.step();
    expect(api.state.queries[1].map((q) => q.types[0])).toEqual(['openCase', 'dismantleItem']);
    expect(api.state.queries[1][0].cursor).toBe('c100');
    await loader.step();
    expect(loader.done).toBe(true);
    expect(api.state.calls).toBe(3);
    expect(api.state.queries.every((qs) => qs.every((q) => q.userId === ME))).toBe(true);
  });

  it('liest ohne Zeitgrenze bis zum Ende der Aufzeichnung', async () => {
    const api = fakeApi(history({ openCase: { count: 1234, everyMs: 500 } }));
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: api.fetch, pageSize: 100 });
    const { got, steps } = await drain(loader);
    expect(got.open).toHaveLength(1234);
    expect(steps).toBe(13);
  });

  it('hört bei leerer Aufzeichnung und bei Aufzeichnung vor dem Zeitraum sofort auf', async () => {
    const empty = new HistoryLoader({ userId: ME, since: iso(T_NOW - 1000), fetch: fakeApi({}).fetch });
    const { got } = await drain(empty);
    expect(got.open).toHaveLength(0);
    expect(empty.done).toBe(true);

    const old = fakeApi(history({ openCase: { count: 10, everyMs: 1000, startMs: T_NOW - 10 * 24 * 3600_000 } }));
    const loader = new HistoryLoader({ userId: ME, since: iso(T_NOW - 24 * 3600_000), streams: ['open'], fetch: old.fetch });
    expect((await drain(loader)).got.open).toHaveLength(0);
    expect(old.state.calls).toBe(1);
  });

  it('liest Zerlegungen und Verkäufe nicht weiter zurück als die älteste Öffnung', async () => {
    // 500 Öffnungen alle 10 s, aber viel längere Ergebnislisten (alle 10 s, 3000 Stück)
    const api = fakeApi(
      history({
        openCase: { count: 500, everyMs: 10_000 },
        dismantleItem: { count: 3000, everyMs: 10_000 },
        itemMarket: { count: 3000, everyMs: 10_000 },
      }),
    );
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: api.fetch, pageSize: 100, startedAt: T_NOW });
    const { got } = await drain(loader);
    expect(got.open).toHaveLength(500);
    // ohne die Begrenzung wären es 30 Seiten je Strom; so reichen wenige Seiten über das Ende der Öffnungen hinaus
    expect(api.state.calls).toBeLessThanOrEqual(7);
    expect(got.scrap.length).toBeLessThan(900);
    expect((got.scrap as Tx[]).every((t) => t.createdAt >= (got.open[499] as Tx).createdAt)).toBe(true);
  });

  it('kürzt bei der Obergrenze für Öffnungen und meldet es', async () => {
    const api = fakeApi(history({ openCase: { count: 1000, everyMs: 1000 }, dismantleItem: { count: 1000, everyMs: 1000 } }));
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: api.fetch, pageSize: 100, maxOpen: 250 });
    const { got } = await drain(loader);
    expect(loader.truncated).toBe(true);
    expect(got.open.length).toBeGreaterThanOrEqual(250);
    expect(got.open.length).toBeLessThan(400);
    // die Ergebnisse reichen nicht über die älteste geladene Öffnung hinaus
    const oldest = (got.open[got.open.length - 1] as Tx).createdAt;
    expect((got.scrap as Tx[]).every((t) => t.createdAt >= oldest)).toBe(true);
    expect(loader.done).toBe(true);
  });

  it('behält bei einem Fehler den Stand und fragt dieselbe Seite noch einmal an', async () => {
    const api = fakeApi(history({ openCase: { count: 250, everyMs: 1000 }, dismantleItem: { count: 250, everyMs: 1000 } }));
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: api.fetch, pageSize: 100 });
    await loader.step();
    const before = JSON.stringify(loader.state);
    api.state.failNext = 1;
    await expect(loader.step()).rejects.toThrow('boom');
    expect(JSON.stringify(loader.state)).toBe(before);
    expect(loader.requests).toBe(1);
    const again = await loader.step();
    expect(api.state.queries[api.state.queries.length - 1][0].cursor).toBe('c100');
    expect((again.open[0] as Tx)._id).toBe('openCase-100');
    const { got } = await drain(loader);
    expect(got.open).toHaveLength(50);
  });

  it('liest nur die gewünschten Ströme', async () => {
    const api = fakeApi(history({ openCase: { count: 50, everyMs: 1000 }, dismantleItem: { count: 50, everyMs: 1000 }, itemMarket: { count: 50, everyMs: 1000 } }));
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['scrap', 'sale'], fetch: api.fetch });
    await drain(loader);
    expect(api.state.queries.flat().some((q) => q.types[0] === 'openCase')).toBe(false);
    expect(loader.state.scrap.count).toBe(50);
    expect(loader.state.open.count).toBe(0);
    expect(loader.state.open.enabled).toBe(false);
  });

  it('überspringt Einträge ohne Zeitstempel', async () => {
    const data = history({ openCase: { count: 3, everyMs: 1000 } });
    data.openCase[1] = { ...data.openCase[1], createdAt: '' };
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: fakeApi(data).fetch });
    expect((await drain(loader)).got.open).toHaveLength(2);
  });

  it('merkt sich neueste und älteste Zeit je Strom', async () => {
    const api = fakeApi(history({ openCase: { count: 30, everyMs: 1000 }, dismantleItem: { count: 20, everyMs: 2000 }, itemMarket: { count: 4, everyMs: 5000 } }));
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: api.fetch, pageSize: 100 });
    await drain(loader);
    expect(loader.state.open.newest).toBe(iso(T_NOW));
    expect(loader.state.open.oldest).toBe(iso(T_NOW - 29_000));
    expect(loader.oldestOpen).toBe(iso(T_NOW - 29_000));
    expect(loader.newestOutcome).toBe(iso(T_NOW));
  });
});

describe('HistoryLoader: Fortschritt', () => {
  it('wächst mit dem erreichten Zeitpunkt, erreicht 1 am Ende und fällt nie zurück', async () => {
    const api = fakeApi(history({ openCase: { count: 1000, everyMs: 60_000 }, dismantleItem: { count: 1000, everyMs: 60_000 } }));
    const since = iso(T_NOW - 600 * 60_000);
    const loader = new HistoryLoader({ userId: ME, since, fetch: api.fetch, pageSize: 100, startedAt: T_NOW });
    expect(loader.progress()).toBe(0);
    const seen: number[] = [];
    while (!loader.done) {
      await loader.step();
      seen.push(loader.progress()!);
    }
    expect(seen[0]).toBeCloseTo(100 / 600, 1); // gut ein Sechstel nach der ersten Seite
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('richtet sich nach dem Strom, der am wenigsten weit zurückreicht', async () => {
    const api = fakeApi(history({ openCase: { count: 1000, everyMs: 60_000 }, dismantleItem: { count: 1000, everyMs: 600_000 } }));
    const loader = new HistoryLoader({ userId: ME, since: iso(T_NOW - 600 * 60_000), fetch: api.fetch, pageSize: 100, startedAt: T_NOW });
    await loader.step();
    // Öffnungen: 100 Minuten zurück; Zerlegungen: 1000 Minuten zurück und damit schon an der Grenze, also fertig
    expect(loader.state.scrap.done).toBe(true);
    expect(loader.progress()).toBeCloseTo(100 / 600, 1);
  });

  it('ist ohne Zeitgrenze unbestimmt, bis alles gelesen ist', async () => {
    const api = fakeApi(history({ openCase: { count: 250, everyMs: 1000 } }));
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: api.fetch, pageSize: 100 });
    await loader.step();
    expect(loader.progress()).toBeNull();
    await drain(loader);
    expect(loader.progress()).toBe(1);
  });
});

describe('RateBudget', () => {
  function clock() {
    const c = { t: 0, waits: [] as number[] };
    return {
      c,
      budget: (max: number, windowMs = 60_000) =>
        new RateBudget(
          max,
          windowMs,
          () => c.t,
          async (ms) => {
            c.waits.push(ms);
            c.t += ms;
          },
        ),
    };
  }

  it('lässt bis zum Limit sofort durch und wartet dann auf das älteste Ende des Fensters', async () => {
    const { c, budget } = clock();
    const b = budget(3);
    await b.take();
    c.t = 10;
    await b.take();
    c.t = 20;
    await b.take();
    expect(c.waits).toEqual([]);
    await b.take(); // viertes im selben Fenster: wartet bis die erste Anfrage (t=0) hinausfällt
    expect(c.waits).toEqual([60_000 - 20]);
    expect(c.t).toBe(60_000);
  });

  it('schüttet nach Ablauf des Fensters wieder aus', async () => {
    const { c, budget } = clock();
    const b = budget(2, 1000);
    await b.take();
    await b.take();
    c.t = 1500;
    await b.take();
    await b.take();
    expect(c.waits).toEqual([]);
  });

  it('hält über viele Anfragen die Rate ein', async () => {
    const { c, budget } = clock();
    const b = budget(5, 1000);
    const stamps: number[] = [];
    for (let i = 0; i < 50; i++) {
      await b.take();
      stamps.push(c.t);
    }
    for (let i = 5; i < stamps.length; i++) expect(stamps[i] - stamps[i - 5]).toBeGreaterThanOrEqual(1000);
  });
});
