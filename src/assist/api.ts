// API-Zugriffe für Kisten-Assistent und Marktcheck. Baut auf dem gebündelten tRPC-Zugriff des
// Kisten-Battles auf (eine HTTP-Anfrage für mehrere Prozeduren, Schlüssel im Header X-API-Key).
//
// Was ein API-Schlüssel nicht darf (geprüft 2026-11-27, Antwort "API tokens cannot access this endpoint"):
// itemOffer.getItemOffers und inventory.getInventory. Die eigenen Ausrüstungsangebote und das Inventar
// sind deshalb nicht lesbar; Orders auf Waren, Kisten und Schrott liefert tradingOrder.getPublicOrdersByOwner.

import { ApiError, batch, unwrap } from '../battle/api';
import type { RawTransaction } from '../battle/logic';

export { ApiError };

const TX = 'transaction.getPaginatedTransactions';

export type TxType = 'openCase' | 'dismantleItem' | 'itemMarket' | 'trading';

export interface TxPage<T = RawTransaction> {
  items: T[];
  nextCursor: string | null;
}

export interface TxQuery {
  /** Ohne Spieler: alle Transaktionen dieser Art (etwa alle Verkäufe eines Itemcodes). */
  userId?: string;
  types: TxType[];
  itemCode?: string;
  limit?: number;
  cursor?: string | null;
}

const txInput = (q: TxQuery) => ({
  ...(q.userId ? { userId: q.userId } : {}),
  transactionType: q.types.length === 1 ? q.types[0] : q.types,
  limit: q.limit ?? 50,
  ...(q.itemCode ? { itemCode: q.itemCode } : {}),
  ...(q.cursor ? { cursor: q.cursor } : {}),
});

/** Mehrere Transaktionsabfragen in einer Anfrage; Fehler einzelner Abfragen werfen. */
export async function fetchTx<T = RawTransaction>(queries: TxQuery[], key: string, timeoutMs = 15_000): Promise<TxPage<T>[]> {
  const results = await batch<{ items?: T[]; nextCursor?: string }>(
    queries.map((q) => ({ path: TX, input: txInput(q) })),
    key,
    timeoutMs,
  );
  return results.map((r) => {
    const data = unwrap(r);
    return { items: data?.items ?? [], nextCursor: data?.nextCursor ?? null };
  });
}

/**
 * Blättert zurück, bis `stop` für einen Eintrag gilt (dann ist alles Ältere bekannt) oder
 * `maxPages` erreicht ist. Liefert neueste zuerst.
 */
export async function fetchTxUntil<T extends { createdAt?: string }>(
  query: TxQuery,
  key: string,
  stop: (tx: T) => boolean,
  maxPages = 20,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let cursor: string | null | undefined = query.cursor;
  for (let page = 0; page < maxPages; page++) {
    const [res] = await fetchTx<T>([{ ...query, cursor, limit: query.limit ?? 100 }], key);
    for (const tx of res.items) {
      if (stop(tx)) return { items, complete: true };
      items.push(tx);
    }
    if (!res.nextCursor || !res.items.length) return { items, complete: true };
    cursor = res.nextCursor;
  }
  return { items, complete: false };
}

// ------------------------------------------------------------------ Märkte

export interface BookOrder {
  _id: string;
  user?: string;
  itemCode: string;
  quantity: number;
  price: number;
  offerAt?: string;
  type: 'buy' | 'sell';
}

export interface Book {
  buy: BookOrder[];
  sell: BookOrder[];
}

/** Orderbücher mehrerer Waren in einer Anfrage (öffentlich), bis zu `limit` Orders je Seite. */
export async function fetchBooks(codes: string[], limit = 20): Promise<Record<string, Book>> {
  if (!codes.length) return {};
  const [res] = await batch<Record<string, { buyOrders?: BookOrder[]; sellOrders?: BookOrder[] }>>(
    [{ path: 'tradingOrder.getTopOrdersPerItemCode', input: { itemCodes: codes, limit } }],
    null,
    15_000,
  );
  const data = unwrap(res) ?? {};
  const out: Record<string, Book> = {};
  for (const code of codes) out[code] = { buy: data[code]?.buyOrders ?? [], sell: data[code]?.sellOrders ?? [] };
  return out;
}

export interface TradingDay {
  valueAt: string;
  avgValue?: number;
  totalValue?: number;
  totalQuantity?: number;
  transactionsCount?: number;
}

/** Tageswerte der letzten 30 Tage je Ware, älteste zuerst; der letzte Tag läuft noch. Fehlende Waren liefern []. */
export async function fetchHistory(codes: string[]): Promise<Record<string, TradingDay[]>> {
  if (!codes.length) return {};
  const res = await batch<{ values?: TradingDay[] }>(
    codes.map((itemCode) => ({ path: 'itemTrading.getItemTrading', input: { itemCode } })),
    null,
    15_000,
  );
  const out: Record<string, TradingDay[]> = {};
  res.forEach((r, i) => (out[codes[i]] = r instanceof ApiError ? [] : (r?.values ?? [])));
  return out;
}

export interface OwnOrders {
  buy: BookOrder[];
  sell: BookOrder[];
  totalBuyMoneyInvested: number;
  totalSellMoneyExpected: number;
}

/** Offene Kauf- und Verkaufsorders eines Spielers auf Waren, Kisten und Schrott. */
export async function fetchOwnOrders(userId: string, key: string | null): Promise<OwnOrders> {
  const [res] = await batch<{ buyOrders?: BookOrder[]; sellOrders?: BookOrder[]; totalBuyMoneyInvested?: number; totalSellMoneyExpected?: number }>(
    [{ path: 'tradingOrder.getPublicOrdersByOwner', input: { userId } }],
    key,
    15_000,
  );
  const data = unwrap(res) ?? {};
  return {
    buy: data.buyOrders ?? [],
    sell: data.sellOrders ?? [],
    totalBuyMoneyInvested: data.totalBuyMoneyInvested ?? 0,
    totalSellMoneyExpected: data.totalSellMoneyExpected ?? 0,
  };
}

/**
 * Anfang der Aufzeichnung eines Spielers: die Kontoerstellung (ms), null wenn sie sich nicht lesen lässt. Davor kann es
 * keine Transaktion geben; bei „alles“ dient sie als Untergrenze für die Planung paralleler Zeitscheiben.
 */
export async function fetchAccountStart(userId: string, key: string | null): Promise<number | null> {
  try {
    const [user] = await batch<{ createdAt?: string }>([{ path: 'user.getUserLite', input: { userId } }], key, 10_000);
    const at = Date.parse(unwrap(user)?.createdAt ?? '');
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Durchschnittspreise aller handelbaren Waren und Kisten (öffentlich). */
export async function fetchPrices(): Promise<Record<string, number>> {
  const [prices] = await batch<Record<string, number>>([{ path: 'itemTrading.getPrices', input: {} }], null);
  return unwrap(prices) ?? {};
}
