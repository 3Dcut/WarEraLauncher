// Datenbeschaffung des Marktchecks: eigene Orders, Orderbücher und Tagesumsätze der betroffenen
// Waren, eigene Handelsfüllungen und Ausrüstungsverkäufe; dazu der Preis-Check für einzelne Items.

import { signal } from '@preact/signals';
import { ApiError, fetchBooks, fetchHistory, fetchOwnOrders, fetchTxUntil, fetchTx, type Book, type OwnOrders, type TradingDay } from '../assist/api';
import { recentAverage } from '../cases/logic';
import { toSale, type Sale } from '../battle/logic';
import { fetchAverages } from '../battle/api';
import { checkOrder, fillsOf, toEquipSale, type EquipSale, type EquipTx, type OrderCheck, type TradeTx } from './logic';
import { t } from '../i18n';

export interface Report {
  userId: string;
  at: number;
  orders: OwnOrders;
  checks: OrderCheck[];
  books: Record<string, Book>;
  history: Record<string, TradingDay[]>;
  /** null: ohne Schlüssel nicht abrufbar. */
  sales: EquipSale[] | null;
  tradesLoaded: boolean;
}

export const report = signal<Report | null>(null);
export const loading = signal(false);
export const error = signal<string | null>(null);

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return t('market.err.keyRejected');
    if (err.status === 429) return t('market.err.throttled');
    if (err.status === 0) return t('market.err.offline');
    return t('market.err.api', { message: err.message });
  }
  return t('market.err.unexpected');
}

const DAYS = 14;

export async function loadReport(userId: string, key: string | null): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    const orders = await fetchOwnOrders(userId, key);
    const all = [...orders.sell, ...orders.buy];
    const codes = [...new Set(all.map((o) => o.itemCode))];
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    const [books, history, trades, equip] = await Promise.all([
      fetchBooks(codes, 50),
      fetchHistory(codes),
      key
        ? fetchTxUntil<TradeTx>({ userId, types: ['trading'], limit: 100 }, key, (tx) => !!tx.createdAt && tx.createdAt < since, 10).catch(() => null)
        : Promise.resolve(null),
      key
        ? fetchTxUntil<EquipTx>({ userId, types: ['itemMarket'], limit: 100 }, key, (tx) => !!tx.createdAt && tx.createdAt < since, 10).catch(() => null)
        : Promise.resolve(null),
    ]);
    const now = Date.now();
    const checks = all.map((order) => {
      const { avg, volume } = recentAverage(history[order.itemCode] ?? []);
      return checkOrder({
        order,
        userId,
        book: books[order.itemCode] ?? null,
        avg7: avg,
        volume7: volume,
        fills: trades ? fillsOf(order, userId, trades.items) : [],
        now,
      });
    });
    // Ältere Verkäufe tragen noch keinen Durchschnittspreis; für sie gilt der aktuelle des Codes
    const fallback: Record<string, number> = {};
    if (equip) {
      const missing = [
        ...new Set(equip.items.filter((tx) => tx.sellerId === userId && !tx.marketAvgPrice).map((tx) => tx.item?.code ?? tx.itemCode ?? '')),
      ].filter(Boolean);
      if (missing.length) {
        const avgs = await fetchAverages(missing).catch(() => []);
        avgs.forEach((a, i) => typeof a === 'number' && a > 0 && (fallback[missing[i]] = a));
      }
    }
    const sales = equip
      ? equip.items.map((tx) => toEquipSale(tx, userId, fallback[tx.item?.code ?? tx.itemCode ?? ''])).filter((s): s is EquipSale => !!s)
      : null;
    report.value = { userId, at: now, orders, checks, books, history, sales, tradesLoaded: !!trades };
  } catch (err) {
    error.value = describe(err);
  } finally {
    loading.value = false;
  }
}

// ------------------------------------------------------------------ Preis prüfen

export interface CodeSales {
  sales: (Sale & { minutes: number | null })[];
  at: number;
}

const salesCache = new Map<string, CodeSales>();

/** Die letzten 100 Verkäufe eines Ausrüstungscodes, mit Dauer vom Angebot bis zum Verkauf. */
export async function loadCodeSales(code: string, key: string): Promise<CodeSales> {
  const hit = salesCache.get(code);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
  const [page] = await fetchTx<EquipTx>([{ types: ['itemMarket'], itemCode: code, limit: 100 }], key);
  const sales = page.items
    .map((tx) => {
      const sale = toSale(tx);
      if (!sale) return null;
      const offered = tx.offerCreatedAt ? Date.parse(tx.offerCreatedAt) : NaN;
      return { ...sale, minutes: Number.isFinite(offered) ? Math.max(0, (Date.parse(sale.at) - offered) / 60_000) : null };
    })
    .filter((s): s is Sale & { minutes: number | null } => !!s);
  const entry = { sales, at: Date.now() };
  salesCache.set(code, entry);
  return entry;
}
