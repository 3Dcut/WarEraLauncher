import { describe, it, expect } from 'vitest';
import { HistoryLoader, forgeCursor, type StreamKey, type Pages } from '../src/cases/loader';
import { RateBudget } from '../src/assist/limiter';
import type { TxQuery } from '../src/assist/api';
import { rng } from '../src/cases/logic';

const ME = 'me';
const T_NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

interface Tx {
  _id: string;
  createdAt: string;
  transactionType: string;
}

const hexId = (n: number) => n.toString(16).padStart(24, '0');

/**
 * Eine Aufzeichnung wie die der API: nach (Zeit, ID) absteigend geordnet, viele gleiche Zeitpunkte (Bursts), der Cursor ein
 * Schlüssel aus Zeit und ID in Base64.
 */
function history(type: string, count: number, seed: number, opts: { spanMs?: number; burst?: number; clusterEnd?: boolean } = {}): Tx[] {
  const rand = rng(seed);
  const span = opts.spanMs ?? 10 * 86_400_000;
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    // klumpige Verteilung: ein großer Teil liegt im jüngsten Zwanzigstel der Spanne
    const u = rand();
    const t = opts.clusterEnd && rand() < 0.9 ? T_NOW - Math.floor(u * span * 0.05) : T_NOW - Math.floor(u * span);
    times.push(Math.floor(t / (opts.burst ?? 1)) * (opts.burst ?? 1));
  }
  times.sort((a, b) => b - a);
  // IDs absteigend entlang der Reihenfolge, damit (Zeit desc, ID desc) eindeutig ist
  return times.map((t, i) => ({ _id: hexId(0x100000 + count - i), createdAt: iso(t), transactionType: type }));
}

const encode = (t: Tx) => 'v2.' + Buffer.from(JSON.stringify([{ t: 'date', v: t.createdAt }, { t: 'str', v: t._id }])).toString('base64url');
const decode = (cursor: string): { at: string; id: string } => {
  const raw = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8')) as { t: string; v: string }[];
  return { at: raw[0].v, id: raw[1].v };
};

interface ApiOptions {
  /** Lehnt Cursor ab, die der Server nicht selbst ausgegeben hat. */
  rejectForged?: boolean;
  /** Ignoriert das Datum eines gebauten Cursors und beginnt wieder beim Neuesten. */
  ignoreForged?: boolean;
}

function fakeApi(data: Record<string, Tx[]>, opts: ApiOptions = {}) {
  const issued = new Set<string>();
  const state = { requests: 0, calls: 0, perRequest: [] as number[], failNext: null as null | { status: number; message: string }, queries: [] as TxQuery[][] };
  const fetch = async (queries: TxQuery[]) => {
    state.requests++;
    state.calls += queries.length;
    state.perRequest.push(queries.length);
    state.queries.push(queries);
    if (state.failNext) {
      const f = state.failNext;
      state.failNext = null;
      throw Object.assign(new Error(f.message), { status: f.status });
    }
    return queries.map((q) => {
      const all = data[q.types[0]] ?? [];
      let from = 0;
      if (q.cursor && !(opts.ignoreForged && !issued.has(q.cursor))) {
        if (opts.rejectForged && !issued.has(q.cursor)) throw Object.assign(new Error('Invalid cursor format: ' + q.cursor), { status: 500 });
        const c = decode(q.cursor);
        // erster Eintrag strikt hinter (Zeit, ID) in absteigender Ordnung
        let lo = 0;
        let hi = all.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const t = all[mid];
          const after = t.createdAt < c.at || (t.createdAt === c.at && t._id < c.id);
          if (after) hi = mid;
          else lo = mid + 1;
        }
        from = lo;
      }
      const limit = q.limit ?? 50;
      const items = all.slice(from, from + limit);
      let nextCursor: string | null = null;
      if (from + limit < all.length && items.length) {
        nextCursor = encode(items[items.length - 1]);
        issued.add(nextCursor);
      }
      return { items, nextCursor };
    });
  };
  return { state, fetch };
}

async function drain(loader: HistoryLoader, maxSteps = 100_000): Promise<{ got: Record<StreamKey, Tx[]>; steps: number }> {
  const got: Record<StreamKey, Tx[]> = { open: [], scrap: [], sale: [] };
  let steps = 0;
  while (!loader.done && steps++ < maxSteps) {
    const page: Pages = await loader.step();
    for (const k of ['open', 'scrap', 'sale'] as StreamKey[]) got[k].push(...(page[k] as unknown as Tx[]));
  }
  return { got, steps };
}

const ids = (txs: Tx[]) => txs.map((t) => t._id).sort();

describe('forgeCursor', () => {
  it('baut einen Cursor im Format der API: Zeit und kleinstmögliche ID', () => {
    const c = forgeCursor(Date.parse('2026-11-27T12:50:27.598Z'));
    expect(c.startsWith('v2.')).toBe(true);
    expect(decode(c)).toEqual({ at: '2026-11-27T12:50:27.598Z', id: '000000000000000000000000' });
    expect(c).not.toMatch(/[+/=]/); // Base64url ohne Auffüllung
  });
});

describe('HistoryLoader: Zeitscheiben', () => {
  it('liest dieselben Einträge wie ein sequentielles Lesen: ohne Lücken und ohne Doppelte', async () => {
    const data = { openCase: history('openCase', 6000, 1, { burst: 1000 }) };
    const sequential = fakeApi(data);
    const a = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: sequential.fetch, slicing: false, startedAt: T_NOW });
    const seq = await drain(a);
    expect(ids(seq.got.open)).toEqual(ids(data.openCase));

    const sliced = fakeApi(data);
    const b = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: sliced.fetch, startedAt: T_NOW, planFrom: T_NOW - 10 * 86_400_000 });
    const par = await drain(b);
    expect(par.got.open).toHaveLength(data.openCase.length);
    expect(ids(par.got.open)).toEqual(ids(data.openCase));
    // parallel gelesen: deutlich weniger Anfragen als Seiten nacheinander
    expect(Math.max(...sliced.state.perRequest)).toBeGreaterThan(8);
    expect(sliced.state.requests).toBeLessThan(sequential.state.requests / 3);
  });

  it('endet an der Zeitgrenze: genau die Einträge ab dieser Zeit, die Grenze eingeschlossen', async () => {
    const data = { openCase: history('openCase', 5000, 2, { burst: 500 }) };
    const since = iso(T_NOW - 4 * 86_400_000);
    const api = fakeApi(data);
    const loader = new HistoryLoader({ userId: ME, since, streams: ['open'], fetch: api.fetch, startedAt: T_NOW });
    const { got } = await drain(loader);
    expect(ids(got.open)).toEqual(ids(data.openCase.filter((t) => t.createdAt >= since)));
  });

  it('verteilt klumpige Aufzeichnungen auf viele Scheiben und bleibt vollständig', async () => {
    const data = { openCase: history('openCase', 20_000, 3, { clusterEnd: true }) };
    const api = fakeApi(data);
    const loader = new HistoryLoader({ userId: ME, since: iso(T_NOW - 10 * 86_400_000), streams: ['open'], fetch: api.fetch, startedAt: T_NOW });
    const { got, steps } = await drain(loader);
    expect(ids(got.open)).toEqual(ids(data.openCase.filter((t) => t.createdAt >= iso(T_NOW - 10 * 86_400_000))));
    expect(Math.max(...api.state.perRequest)).toBeGreaterThanOrEqual(12);
    // 200 Seiten, aber weit weniger Schritte
    expect(steps).toBeLessThan(80);
  });

  it('hält die Zahl der Aufrufe je Anfrage ein und bündelt alle drei Ströme', async () => {
    const data = {
      openCase: history('openCase', 8000, 4),
      dismantleItem: history('dismantleItem', 8000, 5),
      itemMarket: history('itemMarket', 300, 6),
    };
    const api = fakeApi(data);
    const loader = new HistoryLoader({ userId: ME, since: iso(T_NOW - 10 * 86_400_000), fetch: api.fetch, maxCalls: 10, startedAt: T_NOW });
    const { got } = await drain(loader);
    expect(Math.max(...api.state.perRequest)).toBeLessThanOrEqual(10);
    expect(ids(got.open)).toEqual(ids(data.openCase));
    expect(ids(got.scrap)).toEqual(ids(data.dismantleItem));
    expect(ids(got.sale)).toEqual(ids(data.itemMarket));
    const types = new Set(api.state.queries[0].map((q) => q.types[0]));
    expect(types).toEqual(new Set(['openCase', 'dismantleItem', 'itemMarket']));
    expect(api.state.queries.every((qs) => qs.every((q) => q.userId === ME))).toBe(true);
  });

  it('liest Zerlegungen und Verkäufe nicht weiter zurück als die älteste Öffnung', async () => {
    // Öffnungen nur in den letzten 2 Tagen, Ergebnisse über 10 Tage
    const data = {
      openCase: history('openCase', 3000, 7, { spanMs: 2 * 86_400_000 }),
      dismantleItem: history('dismantleItem', 30_000, 8),
      itemMarket: history('itemMarket', 3000, 9),
    };
    const api = fakeApi(data);
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: api.fetch, startedAt: T_NOW, planFrom: T_NOW - 11 * 86_400_000 });
    const { got } = await drain(loader);
    const oldestOpen = data.openCase[data.openCase.length - 1].createdAt;
    expect(ids(got.open)).toEqual(ids(data.openCase));
    // alles, was seit der ältesten Öffnung geschah, ist da
    const needed = data.dismantleItem.filter((t) => t.createdAt >= oldestOpen);
    const loaded = new Set(got.scrap.map((t) => t._id));
    expect(needed.every((t) => loaded.has(t._id))).toBe(true);
    expect(new Set(ids(got.scrap)).size).toBe(got.scrap.length); // ohne Doppelte
    // Parallel gelesene Scheiben laden schon, bevor die älteste Öffnung feststeht (bei begrenzten Zeiträumen gibt es das nicht);
    // danach hört alles Ältere auf. Hier, bei einer fünfmal so langen Ergebnisliste wie Öffnungsliste, bleibt ein Teil ungelesen.
    const olderTotal = data.dismantleItem.length - needed.length;
    const olderLoaded = got.scrap.length - needed.length;
    expect(olderLoaded).toBeLessThan(olderTotal * 0.8);
  });

  it('liest jeden Strom ab seiner eigenen Grenze und schneidet Ergebnisse nicht an der ältesten Öffnung ab', async () => {
    // Öffnungen der letzten 2 Tage, Zerlegungen und Verkäufe über 10 Tage
    const data = {
      openCase: history('openCase', 2000, 21, { spanMs: 2 * 86_400_000 }),
      dismantleItem: history('dismantleItem', 6000, 22),
      itemMarket: history('itemMarket', 600, 23),
    };
    const openFrom = T_NOW - 86_400_000; // Öffnungen nur des letzten Tages
    const outcomesFrom = T_NOW - 5 * 86_400_000; // Ergebnisse der letzten fünf Tage
    const loader = new HistoryLoader({
      userId: ME,
      since: null,
      lower: { open: iso(openFrom), scrap: iso(outcomesFrom), sale: iso(outcomesFrom) },
      floorOutcomes: false,
      fetch: fakeApi(data).fetch,
      startedAt: T_NOW,
    });
    expect(loader.progress()).toBe(0);
    const { got } = await drain(loader);
    const since = (list: Tx[], ms: number) => list.filter((t) => Date.parse(t.createdAt) >= ms);
    expect(ids(got.open)).toEqual(ids(since(data.openCase, openFrom)));
    // Ergebnisse bis zu ihrer Grenze, obwohl die älteste gelesene Öffnung viel jünger ist
    expect(ids(got.scrap)).toEqual(ids(since(data.dismantleItem, outcomesFrom)));
    expect(ids(got.sale)).toEqual(ids(since(data.itemMarket, outcomesFrom)));
    expect(loader.progress()).toBe(1);
  });

  it('meldet ohne Grenze für einen Strom keinen Fortschritt', () => {
    const loader = new HistoryLoader({ userId: ME, since: iso(T_NOW - 86_400_000), lower: { sale: null }, fetch: async () => [], startedAt: T_NOW });
    expect(loader.progress()).toBeNull();
  });

  it('kürzt bei der Obergrenze für Öffnungen und meldet es', async () => {
    const data = { openCase: history('openCase', 20_000, 10) };
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: fakeApi(data).fetch, maxOpen: 3000, startedAt: T_NOW, planFrom: T_NOW - 11 * 86_400_000 });
    const { got } = await drain(loader);
    expect(loader.truncated).toBe(true);
    expect(got.open.length).toBeGreaterThanOrEqual(3000);
    expect(got.open.length).toBeLessThan(5500);
    expect(new Set(ids(got.open)).size).toBe(got.open.length); // auch gekürzt ohne Doppelte
    expect(loader.done).toBe(true);
  });

  it('liest ohne Zeitgrenze und ohne bekannten Anfang bis zum Ende, ohne etwas auszulassen', async () => {
    const data = { openCase: history('openCase', 4000, 11) };
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: fakeApi(data).fetch, startedAt: T_NOW });
    const { got } = await drain(loader);
    expect(ids(got.open)).toEqual(ids(data.openCase));
  });

  it('hört bei leerer Aufzeichnung und bei Aufzeichnung vor dem Zeitraum sofort auf', async () => {
    const empty = new HistoryLoader({ userId: ME, since: iso(T_NOW - 1000), fetch: fakeApi({}).fetch, startedAt: T_NOW });
    expect((await drain(empty)).got.open).toHaveLength(0);
    expect(empty.done).toBe(true);

    const old = fakeApi({ openCase: history('openCase', 50, 12, { spanMs: 1000 }).map((t) => ({ ...t, createdAt: iso(Date.parse(t.createdAt) - 20 * 86_400_000) })) });
    const loader = new HistoryLoader({ userId: ME, since: iso(T_NOW - 86_400_000), streams: ['open'], fetch: old.fetch, startedAt: T_NOW });
    expect((await drain(loader)).got.open).toHaveLength(0);
    expect(old.state.requests).toBe(1);
  });
});

describe('HistoryLoader: Fehler und Rückfall', () => {
  it('fällt zurück, wenn der Server die gebauten Cursor ablehnt, und liest trotzdem alles', async () => {
    const data = { openCase: history('openCase', 6000, 13, { burst: 700 }) };
    const api = fakeApi(data, { rejectForged: true });
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: api.fetch, startedAt: T_NOW, planFrom: T_NOW - 10 * 86_400_000 });
    const { got } = await drain(loader);
    expect(ids(got.open)).toEqual(ids(data.openCase));
    expect(loader.slicing).toBe(false);
    // nach dem Rückfall liest er je Schritt nur noch einen Strom nacheinander
    expect(api.state.perRequest[api.state.perRequest.length - 1]).toBe(1);
  });

  it('bleibt auch dann vollständig und doppelfrei, wenn der Server gebaute Cursor still ignoriert', async () => {
    const data = { openCase: history('openCase', 1500, 14, { burst: 300 }) };
    const api = fakeApi(data, { ignoreForged: true });
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: api.fetch, startedAt: T_NOW, planFrom: T_NOW - 10 * 86_400_000 });
    const { got } = await drain(loader, 5000);
    expect(loader.done).toBe(true);
    expect(ids(got.open)).toEqual(ids(data.openCase));
  });

  it('schaltet die Scheiben bei einem gewöhnlichen Serverfehler nicht ab', async () => {
    const data = { openCase: history('openCase', 8000, 15) };
    const api = fakeApi(data);
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: api.fetch, startedAt: T_NOW, planFrom: T_NOW - 10 * 86_400_000 });
    const got: Tx[] = [];
    let steps = 0;
    let failed = false;
    while (!loader.done && steps++ < 500) {
      if (steps === 4) api.state.failNext = { status: 500, message: 'Internal server error' };
      try {
        got.push(...((await loader.step()).open as unknown as Tx[]));
      } catch {
        failed = true;
      }
    }
    expect(failed).toBe(true);
    expect(loader.slicing).toBe(true);
    expect(ids(got)).toEqual(ids(data.openCase));
  });

  it('behält bei einem Fehler den Stand und holt dieselben Seiten noch einmal', async () => {
    const data = { openCase: history('openCase', 1000, 16), dismantleItem: history('dismantleItem', 1000, 17) };
    const api = fakeApi(data);
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: api.fetch, startedAt: T_NOW, slicing: false });
    const first = await loader.step();
    const before = JSON.stringify(loader.state);
    api.state.failNext = { status: 0, message: 'network' };
    await expect(loader.step()).rejects.toThrow('network');
    expect(JSON.stringify(loader.state)).toBe(before);
    expect(loader.requests).toBe(1);
    const again = await loader.step();
    expect(api.state.queries[api.state.queries.length - 1][0].cursor).toBe(encode(first.open[first.open.length - 1] as unknown as Tx));
    expect((again.open[0] as unknown as Tx)._id).toBe(data.openCase[100]._id);
  });
});

describe('HistoryLoader: Allgemeines', () => {
  it('liest nur die gewünschten Ströme', async () => {
    const data = { openCase: history('openCase', 400, 18), dismantleItem: history('dismantleItem', 400, 19), itemMarket: history('itemMarket', 400, 20) };
    const api = fakeApi(data);
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['scrap', 'sale'], fetch: api.fetch, startedAt: T_NOW });
    await drain(loader);
    expect(api.state.queries.flat().some((q) => q.types[0] === 'openCase')).toBe(false);
    expect(loader.state.scrap.count).toBe(400);
    expect(loader.state.open.enabled).toBe(false);
  });

  it('überspringt Einträge ohne Zeitstempel', async () => {
    const data = { openCase: history('openCase', 5, 21) };
    data.openCase[1] = { ...data.openCase[1], createdAt: '' };
    const loader = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: fakeApi(data).fetch, startedAt: T_NOW });
    expect((await drain(loader)).got.open).toHaveLength(4);
  });

  it('merkt sich neueste und älteste Zeit je Strom', async () => {
    const data = { openCase: history('openCase', 300, 22), dismantleItem: history('dismantleItem', 200, 23) };
    const loader = new HistoryLoader({ userId: ME, since: null, fetch: fakeApi(data).fetch, startedAt: T_NOW });
    await drain(loader);
    expect(loader.state.open.newest).toBe(data.openCase[0].createdAt);
    expect(loader.state.open.oldest).toBe(data.openCase[299].createdAt);
    expect(loader.oldestOpen).toBe(data.openCase[299].createdAt);
    expect(loader.newestOutcome).toBe(data.dismantleItem[0].createdAt);
  });
});

describe('HistoryLoader: Fortschritt', () => {
  it('wächst von 0 bis 1, fällt nie zurück und ist ohne Zeitgrenze unbestimmt', async () => {
    const data = { openCase: history('openCase', 12_000, 24, { clusterEnd: true }), dismantleItem: history('dismantleItem', 12_000, 25, { clusterEnd: true }) };
    const since = iso(T_NOW - 10 * 86_400_000);
    const loader = new HistoryLoader({ userId: ME, since, fetch: fakeApi(data).fetch, startedAt: T_NOW });
    expect(loader.progress()).toBe(0);
    const seen: number[] = [];
    while (!loader.done) {
      await loader.step();
      seen.push(loader.progress()!);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.every((p) => p >= 0 && p <= 1)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.some((p) => p > 0.2 && p < 0.9)).toBe(true); // läuft sichtbar durch die Mitte

    const open = new HistoryLoader({ userId: ME, since: null, streams: ['open'], fetch: fakeApi(data).fetch, startedAt: T_NOW });
    await open.step();
    expect(open.progress()).toBeNull();
    await drain(open);
    expect(open.progress()).toBe(1);
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
    await b.take();
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
