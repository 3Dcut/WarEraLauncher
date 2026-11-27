// API-Zugriff des Kisten-Battles. Transaktionen gibt die WarEra-API nur mit persönlichem
// Schlüssel heraus (Header X-API-Key, CORS erlaubt ihn). Mehrere Abfragen werden per tRPC-Batch
// in einer HTTP-Anfrage gebündelt; die zählt gegen das Limit (mit Schlüssel 500 pro Minute) nur einmal.

import { fallbackRarity, isRarity, toOpening, toSale, type Opening, type Rarity, type RawTransaction, type Sale, type StatRanges } from './logic';

const BASE = 'https://api2.warera.io/trpc';
const TX = 'transaction.getPaginatedTransactions';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

interface Call {
  path: string;
  input: unknown;
}

type BatchEntry<T> = { result?: { data?: T }; error?: { message?: string; data?: { httpStatus?: number } } };

/** Führt mehrere Prozeduren in einer Anfrage aus; einzelne Fehler kommen als ApiError zurück. */
async function batch<T>(calls: Call[], key: string | null, timeoutMs = 8000): Promise<(T | ApiError)[]> {
  const paths = calls.map((c) => c.path).join(',');
  const input: Record<string, unknown> = {};
  calls.forEach((c, i) => (input[i] = c.input));
  const url = `${BASE}/${paths}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { headers: key ? { 'X-API-Key': key } : undefined, cache: 'no-store', signal: controller.signal });
  } catch (err) {
    throw new ApiError((err as Error)?.name === 'AbortError' ? 'timeout' : 'network', 0);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new ApiError('rate-limit', 429);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`HTTP ${res.status}`, res.status);
  }
  if (!Array.isArray(body)) {
    const err = (body as BatchEntry<T>)?.error;
    throw new ApiError(err?.message ?? `HTTP ${res.status}`, err?.data?.httpStatus ?? res.status);
  }
  return (body as BatchEntry<T>[]).map((entry) =>
    entry.error ? new ApiError(entry.error.message ?? 'error', entry.error.data?.httpStatus ?? 500) : (entry.result?.data as T),
  );
}

function unwrap<T>(value: T | ApiError): T {
  if (value instanceof ApiError) throw value;
  return value;
}

// ------------------------------------------------------------------ Seltenheiten und Wertespannen

let rarityTable: Record<string, Rarity> = {};
let statTable: Record<string, StatRanges> = {};

interface ItemConfig {
  rarity?: string;
  dynamicStats?: Record<string, unknown>;
}

/** Lädt Seltenheit und Wertespannen aller Items aus der Spielkonfiguration (einmal pro Tag zwischengespeichert). */
export async function loadItemConfig(): Promise<void> {
  const KEY = 'wb:items';
  try {
    localStorage.removeItem('wb:rarities');
    const cached = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { at: number; rarity: Record<string, Rarity>; stats: Record<string, StatRanges> } | null;
    if (cached?.rarity && cached.stats && Date.now() - cached.at < 24 * 3600_000) {
      rarityTable = cached.rarity;
      statTable = cached.stats;
      return;
    }
  } catch {
    /* gesperrter Speicher */
  }
  try {
    const [cfg] = await batch<{ items?: Record<string, ItemConfig> }>([{ path: 'gameConfig.getGameConfig', input: {} }], null, 15_000);
    const items = unwrap(cfg).items ?? {};
    const rarity: Record<string, Rarity> = {};
    const stats: Record<string, StatRanges> = {};
    for (const [code, item] of Object.entries(items)) {
      if (isRarity(item.rarity)) rarity[code] = item.rarity;
      const ranges: StatRanges = {};
      for (const [stat, span] of Object.entries(item.dynamicStats ?? {})) {
        if (Array.isArray(span) && span.length === 2 && span.every((v) => typeof v === 'number')) ranges[stat] = [span[0], span[1]];
      }
      if (Object.keys(ranges).length) stats[code] = ranges;
    }
    rarityTable = rarity;
    statTable = stats;
    try {
      localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), rarity, stats }));
    } catch {
      /* ignoriert */
    }
  } catch (err) {
    console.warn('[Battle] Spielkonfiguration nicht geladen, Seltenheit wird aus dem Itemcode abgeleitet', err);
  }
}

export function rarityOf(code: string): Rarity | null {
  return rarityTable[code] ?? fallbackRarity(code);
}

export function statRangesOf(code: string): StatRanges | null {
  return statTable[code] ?? null;
}

// ------------------------------------------------------------------ Preise

/** Aktuelle Marktpreise der handelbaren Rohstoffe und Kisten (öffentlich, ohne Schlüssel). */
export async function fetchCasePrices(): Promise<Record<string, number>> {
  const [prices] = await batch<Record<string, number>>([{ path: 'itemTrading.getPrices', input: {} }], null);
  return unwrap(prices) ?? {};
}

/** Wie viele Verkäufe je Itemcode geholt werden: reicht selbst bei mythischen Helmen für gut einen Tag. */
const SALES_LIMIT = 100;

/** Jüngste Verkäufe mehrerer Itemcodes auf dem Itemmarkt, neueste zuerst, in einer Anfrage. */
export async function fetchSales(codes: string[], key: string): Promise<(Sale[] | ApiError)[]> {
  const results = await batch<{ items?: RawTransaction[] }>(
    codes.map((itemCode) => ({ path: TX, input: { transactionType: 'itemMarket', itemCode, limit: SALES_LIMIT } })),
    key,
    15_000,
  );
  return results.map((r) =>
    r instanceof ApiError ? r : (r?.items ?? []).map(toSale).filter((s): s is Sale => !!s),
  );
}

/** Durchschnittspreis je Itemcode laut Server (öffentlich); Rückfall ohne Schlüssel. */
export async function fetchAverages(codes: string[]): Promise<(number | ApiError)[]> {
  return batch<number>(
    codes.map((itemCode) => ({ path: 'gameStat.getEquipmentAvgByCode', input: { itemCode } })),
    null,
  );
}

// ------------------------------------------------------------------ Spieler

export interface Player {
  id: string;
  name: string;
  avatarUrl?: string;
  level?: number;
}

interface UserLite {
  _id: string;
  username: string;
  avatarUrl?: string;
  leveling?: { level?: number };
}

const toPlayer = (u: UserLite): Player => ({ id: u._id, name: u.username, avatarUrl: u.avatarUrl, level: u.leveling?.level });

/** Liest eine Spieler-ID aus einer Eingabe: reine ID oder Profil-Link. */
export function parseUserId(text: string): string | null {
  const m = /(?:^|\/)([a-f\d]{24})(?:$|[/?#])/i.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

export interface Lookup {
  match: Player | null;
  suggestions: Player[];
}

export async function findPlayer(text: string, key: string | null): Promise<Lookup> {
  const query = text.trim();
  if (!query) return { match: null, suggestions: [] };
  const direct = parseUserId(query);
  if (direct) {
    const [u] = await batch<UserLite>([{ path: 'user.getUserLite', input: { userId: direct } }], key);
    return { match: toPlayer(unwrap(u)), suggestions: [] };
  }
  const [search] = await batch<{ userIds?: string[] }>([{ path: 'search.searchAnything', input: { searchText: query } }], key);
  const ids = (unwrap(search).userIds ?? []).slice(0, 8);
  if (!ids.length) return { match: null, suggestions: [] };
  const users = (await batch<UserLite>(ids.map((userId) => ({ path: 'user.getUserLite', input: { userId } })), key))
    .filter((u): u is UserLite => !(u instanceof ApiError) && !!u?._id)
    .map(toPlayer);
  const lower = query.toLowerCase();
  const exact = users.find((u) => u.name.toLowerCase() === lower) ?? null;
  return { match: exact, suggestions: exact ? [] : users };
}

// ------------------------------------------------------------------ Kistenöffnungen

export interface OpeningsQuery {
  userId: string;
  caseCode: string | null;
  limit: number;
  cursor?: string;
}

export interface OpeningsPage {
  openings: Opening[];
  nextCursor: string | null;
  /** Anzahl roher Einträge auf der Seite (vor dem Filtern). */
  size: number;
}

const txInput = (q: OpeningsQuery) => ({
  userId: q.userId,
  transactionType: 'openCase',
  limit: q.limit,
  ...(q.caseCode ? { itemCode: q.caseCode } : {}),
  ...(q.cursor ? { cursor: q.cursor } : {}),
});

/** Holt die jüngsten Kistenöffnungen mehrerer Spieler in einer Anfrage. */
export async function fetchOpenings(queries: OpeningsQuery[], key: string): Promise<OpeningsPage[]> {
  const results = await batch<{ items?: RawTransaction[]; nextCursor?: string }>(
    queries.map((q) => ({ path: TX, input: txInput(q) })),
    key,
  );
  return results.map((r, i) => {
    const data = unwrap(r);
    const items = data?.items ?? [];
    return {
      openings: items.map((tx) => toOpening(tx, queries[i].userId, rarityOf)).filter((o): o is Opening => !!o),
      nextCursor: data?.nextCursor ?? null,
      size: items.length,
    };
  });
}

/** Prüft den Schlüssel mit der kleinstmöglichen Abfrage. */
export async function checkKey(key: string): Promise<'ok' | 'invalid' | 'error'> {
  try {
    const [r] = await batch<unknown>([{ path: TX, input: { limit: 1, transactionType: 'openCase' } }], key);
    if (r instanceof ApiError) return r.status === 401 || r.status === 403 ? 'invalid' : 'error';
    return 'ok';
  } catch (err) {
    return err instanceof ApiError && (err.status === 401 || err.status === 403) ? 'invalid' : 'error';
  }
}
