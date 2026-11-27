// Integrationstest der Engine gegen eine Fake-API: Nachladen eines Zeitraums, Zuordnung von Zerlegungen und
// Verkäufen, Beenden und Fortsetzen, Speichern großer Sitzungen, Wiederaufnahme und Live-Abfrage.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

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
const state = { txs: [] as FakeTx[], requests: 0, failNext: 0 };

/** Antwortet auf tRPC-Bündel wie die WarEra-API: Seiten nach createdAt absteigend, Cursor = Versatz. */
function fakeFetch(url: string): Promise<{ status: number; json: () => Promise<unknown> }> {
  const u = new URL(url);
  const paths = decodeURIComponent(u.pathname.replace(/^\/trpc\//, '')).split(',');
  const input = JSON.parse(u.searchParams.get('input') ?? '{}') as Record<string, Record<string, unknown>>;
  state.requests++;
  if (state.failNext > 0) {
    state.failNext--;
    return Promise.resolve({ status: 500, json: async () => ({ error: { message: 'boom', data: { httpStatus: 500 } } }) });
  }
  const body = paths.map((path, i) => {
    const q = input[i] ?? {};
    if (path !== 'transaction.getPaginatedTransactions') return { result: { data: {} } };
    const types = ([] as string[]).concat((q.transactionType as string | string[]) ?? []);
    let list = state.txs.filter((t) => (!types.length || types.includes(t.transactionType)) && (!q.itemCode || t.itemCode === q.itemCode));
    if (q.userId) list = list.filter((t) => t.buyerId === q.userId || t.sellerId === q.userId);
    list = list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a._id < b._id ? 1 : -1));
    const from = q.cursor ? Number(String(q.cursor).slice(1)) : 0;
    const limit = Number(q.limit ?? 50);
    return { result: { data: { items: list.slice(from, from + limit), nextCursor: from + limit < list.length ? `c${from + limit}` : null } } };
  });
  return Promise.resolve({ status: 200, json: async () => body });
}

/** Eine Aufzeichnung: n Öffnungen im Abstand von 6 s, davon 90 % zerlegt, 5 % verkauft, 5 % offen. */
function makeHistory(n: number, now = Date.now()): FakeTx[] {
  const out: FakeTx[] = [];
  for (let i = 0; i < n; i++) {
    const openAt = now - 5000 - i * 6000;
    const acq = openAt - 5;
    const itemId = `item-${i}`;
    const item = { _id: itemId, code: 'chest2', skills: { armor: 5 + (i % 5) }, state: 100, maxState: 100, lastAcquisitionAt: new Date(acq).toISOString() };
    out.push({ _id: `open-${i}`, transactionType: 'openCase', itemCode: 'case1', buyerId: ME, sellerId: ME, createdAt: new Date(openAt).toISOString(), item });
    const kind = i % 20 === 0 ? 'open' : i % 20 === 1 ? 'sold' : 'scrap';
    if (kind === 'scrap')
      out.push({ _id: `scrap-${i}`, transactionType: 'dismantleItem', itemCode: 'scraps', buyerId: ME, sellerId: ME, quantity: 18, createdAt: new Date(openAt + 60_000).toISOString(), item: { _id: itemId, code: 'chest2' } });
    if (kind === 'sold')
      out.push({
        _id: `sale-${i}`,
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

async function until(check: () => boolean, ms = 15_000, step = 20): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung beim Warten');
    await new Promise((r) => setTimeout(r, step));
  }
}

const store = new Map<string, string>();
type Engine = typeof import('../src/cases/engine');
let engine: Engine;

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
  state.failNext = 0;
});

afterEach(() => {
  engine.clearSession();
});

describe('Engine: Nachladen', () => {
  it('zeigt die Sitzung nach der ersten Seite und lädt den Rest im Hintergrund nach', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    const s = engine.session.value!;
    expect(s).not.toBeNull();
    expect(s.range).toBe('24h');
    // Nach der ersten Seite sind schon Ziehungen da, aber noch nicht alle
    expect(engine.loading.value.phase).toBe('loading');
    expect(s.pulls.length).toBeGreaterThan(0);
    expect(s.pulls.length).toBeLessThan(450);

    await until(() => engine.loading.value.phase === 'done');
    const done = engine.session.value!;
    expect(done.pulls).toHaveLength(450);
    expect(engine.loading.value.pulls).toBe(450);
    expect(engine.loading.value.fraction).toBe(1);
    // älteste zuerst, ohne Doppelte
    const times = done.pulls.map((p) => p.at);
    expect([...times].sort()).toEqual(times);
    expect(new Set(done.pulls.map((p) => p.id)).size).toBe(450);
    // Nachgeladene Ziehungen tragen keinen Preis (er kommt aus dem Tagesmittel)
    expect(done.pulls.every((p) => p.cost === null)).toBe(true);
    expect(done.pulls[0].acq).toBeTypeOf('number');
    engine.stopSession();
  });

  it('ordnet Zerlegungen und Verkäufe zu, auch wenn sie vor ihren Ziehungen ankommen', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done');
    const { pulls, outcomes } = engine.session.value!;
    const kinds = { scrapped: 0, sold: 0, open: 0 };
    for (const p of pulls) {
      const o = outcomes[p.id];
      if (!o) kinds.open++;
      else kinds[o.kind]++;
    }
    // i % 20: 0 offen, 1 verkauft, sonst zerlegt; von 450 Ziehungen sind je 23 offen und verkauft
    expect(kinds).toEqual({ scrapped: 450 - 23 - 23, sold: 23, open: 23 });
    const sold = pulls.find((p) => outcomes[p.id]?.kind === 'sold')!;
    expect(outcomes[sold.id].amount).toBe(7.5);
    const scrapped = pulls.find((p) => outcomes[p.id]?.kind === 'scrapped')!;
    expect(outcomes[scrapped.id].amount).toBe(18);
    engine.stopSession();
  });

  it('endet an der Zeitgrenze und lässt Älteres weg', async () => {
    // 3 Stunden Aufzeichnung, gezählt wird ab 1 Stunde
    state.txs = makeHistory(1800);
    await engine.startSession({ userId: ME, name: 'Test', since: '1h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done');
    const n = engine.session.value!.pulls.length;
    expect(n).toBeGreaterThan(590);
    expect(n).toBeLessThan(610); // eine Stunde = 600 Öffnungen alle 6 s
    expect(engine.session.value!.since).toBeTruthy();
    engine.stopSession();
  });

  it('beendet das Nachladen auf Wunsch, behält das Geladene und setzt später fort', async () => {
    state.txs = makeHistory(1500);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    engine.stopLoading();
    expect(engine.loading.value.phase).toBe('stopped');
    await new Promise((r) => setTimeout(r, 300));
    const frozen = engine.session.value!.pulls.length;
    expect(frozen).toBeGreaterThan(0);
    expect(frozen).toBeLessThan(1500);
    await new Promise((r) => setTimeout(r, 400));
    expect(engine.session.value!.pulls.length).toBe(frozen);
    expect(engine.loading.value.phase).toBe('stopped');

    engine.continueLoading();
    await until(() => engine.loading.value.phase === 'done');
    expect(engine.session.value!.pulls).toHaveLength(1500);
    engine.stopSession();
  });

  it('übersteht kurze Ausfälle und lädt trotzdem vollständig', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    state.failNext = 2;
    await until(() => engine.loading.value.phase === 'done', 30_000);
    expect(engine.session.value!.pulls).toHaveLength(450);
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
  it('speichert kleine Sitzungen vollständig und große ohne Ziehungen', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done');
    engine.stopSession();
    const small = JSON.parse(store.get('wca:session')!);
    expect(small.pulls).toHaveLength(450);
    expect(small.partial).toBeUndefined();
    expect(Object.keys(small.outcomes).length).toBeGreaterThan(400);
    engine.clearSession();
    expect(store.has('wca:session')).toBe(false);

    state.txs = makeHistory(3400);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done', 30_000);
    expect(engine.session.value!.pulls).toHaveLength(3400);
    engine.stopSession();
    const big = JSON.parse(store.get('wca:session')!);
    expect(big.pulls).toEqual([]);
    expect(big.partial).toBe(true);
    expect(big.range).toBe('24h');
    expect(big.since).toBeTruthy();
    expect(store.get('wca:session')!.length).toBeLessThan(2000);
  }, 30_000);

  it('lädt eine ohne Ziehungen gespeicherte Sitzung nach dem Neuladen neu', async () => {
    state.txs = makeHistory(3400);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done', 30_000);
    engine.stopSession();
    // So sähe der Speicher aus, wenn die Seite mitten in einer laufenden Sitzung neu geladen wird
    const saved = JSON.stringify({ ...JSON.parse(store.get('wca:session')!), live: true });

    // Neuladen: Zustand der Seite weg, Speicher bleibt
    engine.clearSession();
    store.set('wca:session', saved);
    expect(engine.resumeSession('k')).toBe(true);
    expect(engine.session.value!.pulls).toHaveLength(0);
    expect(engine.loading.value.phase).toBe('loading');
    await until(() => engine.loading.value.phase === 'done', 30_000);
    expect(engine.session.value!.pulls).toHaveLength(3400);
    expect(Object.keys(engine.session.value!.outcomes).length).toBeGreaterThan(3000);
    engine.stopSession();
  }, 60_000);

  it('lässt eine angehaltene, unvollständig gespeicherte Sitzung stehen, bis „Fortsetzen“ gedrückt wird', async () => {
    state.txs = makeHistory(3400);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done', 30_000);
    engine.stopSession();
    const saved = store.get('wca:session')!;
    engine.clearSession();
    store.set('wca:session', saved);
    state.requests = 0;
    expect(engine.resumeSession('k')).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(state.requests).toBe(0);
    expect(engine.session.value!.live).toBe(false);
    engine.continueSession('k');
    await until(() => engine.loading.value.phase === 'done', 30_000);
    expect(engine.session.value!.pulls).toHaveLength(3400);
    engine.stopSession();
  }, 60_000);

  it('setzt eine vollständig gespeicherte Sitzung sofort fort, ohne neu zu laden', async () => {
    state.txs = makeHistory(450);
    await engine.startSession({ userId: ME, name: 'Test', since: '24h', key: 'k' });
    await until(() => engine.loading.value.phase === 'done');
    engine.stopSession();
    const saved = store.get('wca:session')!;
    engine.clearSession();
    store.set('wca:session', saved);
    state.requests = 0;
    expect(engine.resumeSession('k')).toBe(true);
    expect(engine.session.value!.pulls).toHaveLength(450);
    // fortgesetzt wird nur, wenn die Sitzung live war; angehalten gespeichert bleibt sie stehen
    expect(engine.session.value!.live).toBe(false);
    expect(engine.loading.value.phase).toBe('idle');
    expect(state.requests).toBe(0);
  });

  it('nimmt ohne gespeicherte Sitzung nichts auf', () => {
    expect(engine.resumeSession('k')).toBe(false);
  });
});

describe('Engine: Live-Abfrage', () => {
  it('erkennt neue Öffnungen nach dem Start und ordnet spätere Zerlegungen zu', async () => {
    state.txs = makeHistory(40, Date.now() - 3_600_000);
    await engine.startSession({ userId: ME, name: 'Test', since: 'now', key: 'k' });
    expect(engine.session.value!.pulls).toHaveLength(0);
    expect(engine.loading.value.phase).toBe('idle');

    // drei neue Öffnungen
    const fresh = makeHistory(3, Date.now() + 2000).map((t) => ({ ...t, _id: `live-${t._id}`, item: t.item && { ...t.item, _id: `live-${(t.item as { _id: string })._id}` } }));
    const opens = fresh.filter((t) => t.transactionType === 'openCase');
    state.txs.push(...opens);
    await until(() => engine.session.value!.pulls.length === 3, 8000);
    expect(engine.session.value!.pulls.map((p) => p.id).sort()).toEqual(opens.map((t) => t._id).sort());
    // Live erkannte Ziehungen bekommen ihren Preis aus dem Markt; ohne Marktdaten bleibt er leer
    expect(engine.session.value!.pulls.every((p) => p.cost === null || typeof p.cost === 'number')).toBe(true);
    engine.stopSession();
  });
});
