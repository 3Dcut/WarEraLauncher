// Integrationstest der Engine gegen eine Fake-API mit dem Cursorformat der echten: Nachladen eines Zeitraums in Zeitscheiben,
// Zuordnung von Zerlegungen und Verkäufen, Beenden und Fortsetzen, Speichern der Metadaten, Wiederaufnahme und Live-Abfrage.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { KIND_OPEN, KIND_SCRAP, KIND_SOLD } from '../src/cases/store';

interface FakeTx {
  _id: string;
  transactionType: string;
  itemCode: string;
  buyerId: string;
  sellerId: string;
  createdAt: string;
  quantity?: number;
  money?: number;
  item?: Record<string, unknown>;
}

const ME = 'u-test';
const state = {
  txs: [] as FakeTx[],
  requests: 0,
  perRequest: [] as number[],
  failNext: 0,
  rejectForged: false,
  issued: new Set<string>(),
};

const hex = (n: number) => n.toString(16).padStart(24, '0');
const encode = (t: FakeTx) => 'v2.' + Buffer.from(JSON.stringify([{ t: 'date', v: t.createdAt }, { t: 'str', v: t._id }])).toString('base64url');
const decode = (cursor: string): { at: string; id: string } => {
  const raw = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8')) as { v: string }[];
  return { at: raw[0].v, id: raw[1].v };
};

let sortedFor: FakeTx[] | null = null;
let sorted: Record<string, FakeTx[]> = {};
function byType(type: string): FakeTx[] {
  if (sortedFor !== state.txs || Object.values(sorted).reduce((s, l) => s + l.length, 0) !== state.txs.length) {
    sortedFor = state.txs;
    sorted = {};
    for (const t of state.txs) (sorted[t.transactionType] ??= []).push(t);
    for (const list of Object.values(sorted)) list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a._id < b._id ? 1 : -1));
  }
  return sorted[type] ?? [];
}

/** Antwortet auf tRPC-Bündel wie die WarEra-API: nach (Zeit, ID) absteigend, Cursor als Schlüssel aus beidem. */
function fakeFetch(url: string): Promise<{ status: number; json: () => Promise<unknown> }> {
  const u = new URL(url);
  const paths = decodeURIComponent(u.pathname.replace(/^\/trpc\//, '')).split(',');
  const input = JSON.parse(u.searchParams.get('input') ?? '{}') as Record<string, Record<string, unknown>>;
  state.requests++;
  state.perRequest.push(paths.length);
  if (state.failNext > 0) {
    state.failNext--;
    return Promise.resolve({ status: 500, json: async () => [{ error: { message: 'boom', data: { httpStatus: 500 } } }] });
  }
  const body = paths.map((path, i) => {
    const q = input[i] ?? {};
    if (path === 'user.getUserLite') return { result: { data: { _id: q.userId, username: 'Test', createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() } } };
    if (path !== 'transaction.getPaginatedTransactions') return { result: { data: {} } };
    const types = ([] as string[]).concat((q.transactionType as string | string[]) ?? []);
    let list = types.length === 1 ? byType(types[0]) : types.flatMap((t) => byType(t));
    if (q.itemCode) list = list.filter((t) => t.itemCode === q.itemCode);
    if (q.userId && q.userId !== ME) list = [];
    let from = 0;
    if (q.cursor) {
      const cursor = String(q.cursor);
      if (state.rejectForged && !state.issued.has(cursor)) return { error: { message: `Invalid cursor format: ${cursor}`, data: { httpStatus: 500 } } };
      const c = decode(cursor);
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const t = list[mid];
        if (t.createdAt < c.at || (t.createdAt === c.at && t._id < c.id)) hi = mid;
        else lo = mid + 1;
      }
      from = lo;
    }
    const limit = Number(q.limit ?? 50);
    const items = list.slice(from, from + limit);
    let nextCursor: string | null = null;
    if (from + limit < list.length && items.length) {
      nextCursor = encode(items[items.length - 1]);
      state.issued.add(nextCursor);
    }
    return { result: { data: { items, nextCursor } } };
  });
  return Promise.resolve({ status: 200, json: async () => body });
}

/**
 * Eine Aufzeichnung: n Öffnungen im Abstand von 6 s (je `group` Stück mit gleichem Zeitstempel), davon 90 % zerlegt, 5 % verkauft,
 * 5 % offen. IDs sinken mit der Zeit, wie bei der API.
 */
function makeHistory(n: number, opts: { now?: number; group?: number } = {}): FakeTx[] {
  const now = opts.now ?? Date.now();
  const group = opts.group ?? 1;
  const out: FakeTx[] = [];
  for (let i = 0; i < n; i++) {
    const openAt = now - 5000 - Math.floor(i / group) * 6000;
    const acq = openAt - 5;
    const itemId = hex(0x700000 - i);
    const item = { _id: itemId, code: 'chest2', skills: { armor: 5 + (i % 5) }, state: 100, maxState: 100, lastAcquisitionAt: new Date(acq).toISOString() };
    out.push({ _id: hex(0x600000 - i), transactionType: 'openCase', itemCode: 'case1', buyerId: ME, sellerId: ME, createdAt: new Date(openAt).toISOString(), item });
    const kind = i % 20 === 0 ? 'open' : i % 20 === 1 ? 'sold' : 'scrap';
    if (kind === 'scrap')
      out.push({
        _id: hex(0x500000 - i),
        transactionType: 'dismantleItem',
        itemCode: 'scraps',
        buyerId: ME,
        sellerId: ME,
        quantity: 18,
        createdAt: new Date(openAt + 60_000).toISOString(),
        item: { _id: itemId, code: 'chest2' },
      });
    if (kind === 'sold')
      out.push({
        _id: hex(0x400000 - i),
        transactionType: 'itemMarket',
        itemCode: 'chest2',
        buyerId: 'someone',
        sellerId: ME,
        money: 7.5,
        quantity: 1,
        createdAt: new Date(openAt + 3_600_000).toISOString(),
        item: { ...item, _id: `bought-${i}` },
      });
  }
  return out;
}


/** Neue Öffnungen, die jünger sind als alles in der Aufzeichnung (wie in Wirklichkeit), mit höheren IDs. */
function newerOpens(count: number): FakeTx[] {
  return makeHistory(count, { now: Date.now() + 60_000 })
    .filter((t) => t.transactionType === 'openCase')
    .map((t, i) => ({ ...t, _id: hex(0x6ffff0 + i), item: { ...t.item, _id: hex(0x7ffff0 + i) } }));
}

async function until(check: () => boolean, ms = 20_000, step = 20): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung beim Warten');
    await new Promise((r) => setTimeout(r, step));
  }
}

const store = new Map<string, string>();
type Engine = typeof import('../src/cases/engine');
let engine: Engine;

const kinds = () => {
  const st = engine.getStore();
  const k = { scrapped: 0, sold: 0, open: 0 };
  for (let i = 0; i < st.n; i++) {
    const v = st.kind[i];
    if (v === KIND_SCRAP) k.scrapped++;
    else if (v === KIND_SOLD) k.sold++;
    else if (v === KIND_OPEN) k.open++;
  }
  return k;
};
const loaded = (n: number) => () => engine.loading.value.phase === 'done' && engine.getStore().published === n;

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  engine = await import('../src/cases/engine');
});

beforeEach(() => {
  store.clear();
  state.txs = [];
  state.requests = 0;
  state.perRequest = [];
  state.failNext = 0;
  state.rejectForged = false;
  state.issued = new Set();
});

afterEach(() => {
  engine.clearSession();
});

describe('Engine: Nachladen', () => {
  it('zeigt die Sitzung nach der ersten Seite und lädt den Rest im Hintergrund nach', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    const s = engine.session.value!;
    expect(s.range).toBe('24h');
    // Nach der ersten Seite sind schon Ziehungen da, aber noch nicht alle
    expect(engine.loading.value.phase).toBe('loading');
    expect(engine.getStore().n).toBeGreaterThan(0);
    expect(engine.getStore().n).toBeLessThan(450);

    await until(loaded(450));
    expect(engine.getStore().n).toBe(450);
    expect(engine.loading.value.pulls).toBe(450);
    expect(engine.loading.value.fraction).toBe(1);
    // Nachgeladene Ziehungen tragen keinen Preis (er kommt aus dem Tagesmittel), aber ihre Erwerbszeit
    const st = engine.getStore();
    expect(st.cost.subarray(0, 450).every((c) => Number.isNaN(c))).toBe(true);
    expect(st.acqOf(0)).toBeTypeOf('number');
    // in zeitlicher Reihenfolge
    for (let k = 1; k < st.published; k++) expect(st.at[st.order[k]]).toBeGreaterThanOrEqual(st.at[st.order[k - 1]]);
    engine.stopSession();
  });

  it('ist nach der ersten Anfrage fertig, wenn der ganze Zeitraum darin Platz hat', async () => {
    state.txs = makeHistory(30);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    expect(engine.getStore().n).toBe(30);
    expect(engine.loading.value.phase).toBe('done');
    expect(engine.loading.value.fraction).toBe(1);
    expect(engine.loading.value.pulls).toBe(30);
    // i % 20: 0 offen, 1 verkauft, sonst zerlegt: bei 30 Ziehungen je zweimal offen und verkauft
    expect(kinds()).toEqual({ scrapped: 26, sold: 2, open: 2 });
    engine.stopSession();
  });

  it('ist bei einem Zeitraum ohne Kisten sofort fertig und bleibt es', async () => {
    // die Aufzeichnung liegt fünf Stunden zurück, gezählt wird die letzte Stunde
    state.txs = makeHistory(30, { now: Date.now() - 5 * 3_600_000 });
    await engine.startSession({ userId: ME, name: 'Test', since: '1h', key: 'k' });
    expect(engine.session.value).not.toBeNull();
    expect(engine.getStore().n).toBe(0);
    expect(engine.loading.value.phase).toBe('done');
    expect(engine.loading.value.pulls).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.loading.value.phase).toBe('done');
    engine.stopSession();
  });

  it('ordnet Zerlegungen und Verkäufe zu, auch wenn sie vor ihren Ziehungen ankommen', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(loaded(450));
    // i % 20: 0 offen, 1 verkauft, sonst zerlegt; von 450 Ziehungen sind je 23 offen und verkauft
    expect(kinds()).toEqual({ scrapped: 450 - 23 - 23, sold: 23, open: 23 });
    const st = engine.getStore();
    for (let i = 0; i < st.n; i++) {
      if (st.kind[i] === KIND_SOLD) expect(st.amount[i]).toBeCloseTo(7.5);
      if (st.kind[i] === KIND_SCRAP) expect(st.amount[i]).toBe(18);
    }
    engine.stopSession();
  });

  it('liest große Zeiträume in Zeitscheiben parallel: vollständig, ohne Doppelte, in wenigen Anfragen', async () => {
    const n = 8000;
    state.txs = makeHistory(n, { group: 25 }); // Bursts mit gleichem Zeitstempel
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(loaded(n), 30_000);
    expect(engine.getStore().n).toBe(n);
    const k = kinds();
    expect(k.sold + k.scrapped + k.open).toBe(n);
    expect(k.sold).toBe(n / 20);
    expect(k.open).toBe(n / 20);
    expect(Math.max(...state.perRequest)).toBeGreaterThan(6);
    // 8.000 + 7.600 + 400 Einträge: nacheinander wären es gut 160 Anfragen
    expect(state.requests).toBeLessThan(60);
    engine.stopSession();
  }, 40_000);

  it('endet an der Zeitgrenze und lässt Älteres weg', async () => {
    // 3 Stunden Aufzeichnung, gezählt wird ab 1 Stunde
    state.txs = makeHistory(1800);
    await engine.startSession({ userId: ME, name: 'Test', since: '1h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done');
    const n = engine.getStore().n;
    expect(n).toBeGreaterThan(590);
    expect(n).toBeLessThan(610); // eine Stunde = 600 Öffnungen alle 6 s
    expect(engine.session.value!.since).toBeTruthy();
    engine.stopSession();
  });

  it('liest „alles“ bis zum Ende und braucht dafür den Anfang des Kontos nur als Hinweis', async () => {
    state.txs = makeHistory(900);
    await engine.startSession({ userId: ME, name: 'Test', since: 'all', key: 'k' });
    expect(engine.session.value!.since).toBeNull();
    await until(loaded(900));
    expect(engine.getStore().n).toBe(900);
    engine.stopSession();
  });

  it('beendet das Nachladen auf Wunsch, behält das Geladene und setzt später fort', async () => {
    state.txs = makeHistory(4000);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    engine.stopLoading();
    expect(engine.loading.value.phase).toBe('stopped');
    await new Promise((r) => setTimeout(r, 300));
    const frozen = engine.getStore().n;
    expect(frozen).toBeGreaterThan(0);
    expect(frozen).toBeLessThan(4000);
    await new Promise((r) => setTimeout(r, 400));
    expect(engine.getStore().n).toBe(frozen);
    expect(engine.loading.value.phase).toBe('stopped');

    engine.continueLoading();
    await until(loaded(4000));
    expect(engine.getStore().n).toBe(4000);
    engine.stopSession();
  });

  it('übersteht kurze Ausfälle und lädt trotzdem vollständig', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    state.failNext = 2;
    await until(loaded(450), 30_000);
    expect(engine.getStore().n).toBe(450);
    engine.stopSession();
  }, 40_000);

  it('liest sequentiell weiter, wenn der Server die gebauten Cursor ablehnt', async () => {
    state.rejectForged = true;
    state.txs = makeHistory(3000);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(loaded(3000), 30_000);
    expect(engine.getStore().n).toBe(3000);
    expect(kinds().sold).toBe(150);
    engine.stopSession();
  }, 40_000);

  it('meldet einen Fehler schon beim Start, ohne eine Sitzung anzulegen', async () => {
    state.txs = makeHistory(10);
    state.failNext = 1;
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    expect(engine.session.value).toBeNull();
    expect(engine.status.value.state).toBe('error');
  });

  it('verlangt für „Datum“ ein gültiges Datum', async () => {
    state.txs = makeHistory(10);
    await engine.startSession({ userId: ME, name: 'Test', since: 'date', date: '', key: 'k' });
    expect(engine.session.value).toBeNull();
    expect(engine.status.value.state).toBe('error');
    expect(state.requests).toBe(0);
  });
});

describe('Engine: Speichern und Wiederaufnahme', () => {
  it('speichert nur Metadaten, auch bei vielen Kisten', async () => {
    state.txs = makeHistory(3400);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(loaded(3400), 30_000);
    engine.stopSession();
    const saved = JSON.parse(store.get('wca:session')!);
    expect(saved).toMatchObject({ userId: ME, name: 'Test', range: '24h', live: false, demo: false, v: 2 });
    expect(saved.pulls).toBeUndefined();
    expect(store.get('wca:session')!.length).toBeLessThan(600);
    engine.clearSession();
    expect(store.has('wca:session')).toBe(false);
  }, 40_000);

  it('lädt eine angehaltene Sitzung nach dem Neuladen neu und lässt sie angehalten', async () => {
    state.txs = makeHistory(3400);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(loaded(3400), 30_000);
    engine.stopSession();
    const saved = store.get('wca:session')!;

    // Neuladen: Zustand der Seite weg, Speicher bleibt
    engine.clearSession();
    store.set('wca:session', saved);
    state.requests = 0;
    expect(engine.resumeSession('k')).toBe(true);
    expect(engine.getStore().n).toBe(0);
    expect(engine.session.value!.live).toBe(false);
    expect(engine.loading.value.phase).toBe('loading');
    await until(loaded(3400), 30_000);
    expect(engine.getStore().n).toBe(3400);
    expect(kinds().scrapped).toBeGreaterThan(3000);
    // angehalten: keine Live-Abfrage der letzten Öffnungen (die liefe mit limit 25 und alle 1,5 s)
    const before = state.requests;
    await new Promise((r) => setTimeout(r, 1800));
    expect(state.requests).toBe(before);
    engine.continueSession('k');
    expect(engine.session.value!.live).toBe(true);
    engine.stopSession();
  }, 60_000);

  it('setzt eine live gespeicherte Sitzung nach dem Neuladen fort und doppelt nichts', async () => {
    state.txs = makeHistory(3000);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(loaded(3000), 30_000);
    engine.stopSession();
    const saved = JSON.stringify({ ...JSON.parse(store.get('wca:session')!), live: true });
    engine.clearSession();
    store.set('wca:session', saved);
    expect(engine.resumeSession('k')).toBe(true);
    expect(engine.session.value!.live).toBe(true);
    // zwischen den Neuladen kommen drei neue Öffnungen
    state.txs = [...state.txs, ...newerOpens(3)];
    await until(() => engine.getStore().published === 3003 && engine.loading.value.phase === 'done', 30_000);
    expect(engine.getStore().n).toBe(3003);
    engine.stopSession();
  }, 60_000);

  it('nimmt ohne gespeicherte Sitzung nichts auf und übernimmt Sitzungen aus der alten Fassung', () => {
    expect(engine.resumeSession('k')).toBe(false);
    // die frühere Fassung speicherte Ziehungen und Ergebnisse mit; die Metadaten genügen jetzt
    store.set('wca:session', JSON.stringify({ userId: ME, name: 'Alt', startedAt: Date.now() - 1000, since: new Date(Date.now() - 3600_000).toISOString(), seen: [], pulls: [{ id: 'x' }], outcomes: {}, live: false, demo: false }));
    state.txs = makeHistory(30);
    expect(engine.resumeSession('k')).toBe(true);
    expect(engine.session.value!.name).toBe('Alt');
    engine.stopSession();
  });
});

describe('Engine: Live-Abfrage', () => {
  it('erkennt neue Öffnungen nach dem Start', async () => {
    state.txs = makeHistory(40, { now: Date.now() - 3_600_000 });
    await engine.startSession({ userId: ME, name: 'Test', since: 'now', key: 'k' });
    expect(engine.getStore().n).toBe(0);
    expect(engine.loading.value.phase).toBe('idle');

    // drei neue Öffnungen
    state.txs.push(...newerOpens(3));
    await until(() => engine.getStore().published === 3, 8000);
    expect(engine.getStore().n).toBe(3);
    // erneutes Lesen derselben Seite bringt nichts Doppeltes
    await new Promise((r) => setTimeout(r, 3200));
    expect(engine.getStore().n).toBe(3);
    engine.stopSession();
  }, 20_000);

  it('doppelt beim Nachladen nichts, wenn gleichzeitig neue Öffnungen kommen', async () => {
    const n = 5000;
    state.txs = makeHistory(n);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    state.txs = [...state.txs, ...newerOpens(3)];
    await until(() => engine.loading.value.phase === 'done' && engine.getStore().published === n + 3, 30_000);
    expect(engine.getStore().n).toBe(n + 3);
    engine.stopSession();
  }, 40_000);
});
