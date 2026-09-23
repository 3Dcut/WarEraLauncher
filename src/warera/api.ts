// Schlanker Client für die öffentliche WarEra-API (tRPC über GET, CORS offen, ohne Schlüssel,
// Limit 100 Anfragen pro Minute und IP). Antworten werden zwischengespeichert; große Listen
// (Länder, Regionen, Spielkonfiguration) nur als verkleinerte Auszüge im localStorage.

import { fetchJson, HttpError } from '../core/http';
import { load, save } from '../core/storage';

const BASE = 'https://api2.warera.io/trpc';

interface TrpcResponse<T> {
  result?: { data?: T };
}

const memory = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
let backoffUntil = 0;

export async function trpc<T>(proc: string, input?: unknown, ttlMs = 60_000): Promise<T> {
  const url = input === undefined ? `${BASE}/${proc}` : `${BASE}/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const hit = memory.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const running = inflight.get(url);
  if (running) return running as Promise<T>;

  const task = (async () => {
    if (Date.now() < backoffUntil) {
      if (hit) return hit.value as T;
      await new Promise((r) => setTimeout(r, backoffUntil - Date.now()));
    }
    try {
      const res = await fetchJson<TrpcResponse<T>>(url, { timeoutMs: 20_000 });
      const value = res.result?.data as T;
      memory.set(url, { at: Date.now(), value });
      return value;
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) backoffUntil = Date.now() + 30_000;
      if (hit) return hit.value as T; // lieber alte Daten als gar keine
      throw err;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, task);
  return task;
}

/** Zwischenspeicher im localStorage für abgeleitete, kleine Daten. */
async function cached<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  const entry = load<{ at: number; value: T } | null>(`cache:${key}`, null);
  if (entry && Date.now() - entry.at < ttlMs) return entry.value;
  try {
    const value = await produce();
    save(`cache:${key}`, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (entry) return entry.value;
    throw err;
  }
}

// ------------------------------------------------------------------ Zeiten

export interface GameDates {
  nextDayAt: string;
  nextRegenAt: string;
  previousDayAt?: string;
  nextCongressElectionsAt?: string;
  nextPresidentialElectionsAt?: string;
  nextMonthAt?: string;
  dailyMissionRegenAt?: string;
  weeklyMissionRegenAt?: string;
  monthlyMissionRegenAt?: string;
}

export function getDates(): Promise<GameDates> {
  return trpc<GameDates>('gameConfig.getDates', undefined, 5 * 60_000);
}

// ------------------------------------------------------------------ Markt

export type Prices = Record<string, number>;

export function getPrices(): Promise<Prices> {
  return trpc<Prices>('itemTrading.getPrices', undefined, 3 * 60_000);
}

export interface Order {
  price: number;
  quantity: number;
}

export async function getTopOrders(itemCode: string): Promise<{ buy: Order[]; sell: Order[] }> {
  const data = await trpc<{ buyOrders?: Order[]; sellOrders?: Order[] }>('tradingOrder.getTopOrders', { itemCode, limit: 5 }, 60_000);
  return { buy: data.buyOrders ?? [], sell: data.sellOrders ?? [] };
}

export interface ItemInfo {
  type: string;
  pp: number | null;
  needs: Record<string, number> | null;
}

export function getItems(): Promise<Record<string, ItemInfo>> {
  return cached('items', 24 * 3600_000, async () => {
    const cfg = await trpc<{ items?: Record<string, { type?: string; productionPoints?: number; productionNeeds?: Record<string, number> | null }> }>(
      'gameConfig.getGameConfig',
      undefined,
      3600_000,
    );
    const out: Record<string, ItemInfo> = {};
    for (const [code, item] of Object.entries(cfg.items ?? {})) {
      out[code] = { type: item.type ?? 'unknown', pp: item.productionPoints ?? null, needs: item.productionNeeds ?? null };
    }
    return out;
  });
}

// ------------------------------------------------------------------ Länder & Regionen

export interface CountryInfo {
  name: string;
  code: string;
}

export function getCountries(): Promise<Record<string, CountryInfo>> {
  return cached('countries', 24 * 3600_000, async () => {
    const list = await trpc<{ _id: string; name: string; code: string }[]>('country.getAllCountries', undefined, 3600_000);
    const out: Record<string, CountryInfo> = {};
    for (const c of list) out[c._id] = { name: c.name, code: c.code };
    return out;
  });
}

export function getRegions(): Promise<Record<string, string>> {
  return cached('regions', 24 * 3600_000, async () => {
    const obj = await trpc<Record<string, { name?: string }>>('region.getRegionsObject', undefined, 3600_000);
    const out: Record<string, string> = {};
    for (const [id, r] of Object.entries(obj)) out[id] = r.name ?? id;
    return out;
  });
}

// ------------------------------------------------------------------ Schlachten

export interface BattleSide {
  country: string;
  region?: string;
  wonRoundsCount?: number;
  moneyPool?: number;
}

export interface Battle {
  _id: string;
  type?: string;
  attacker: BattleSide;
  defender: BattleSide;
  roundsToWin?: number;
  createdAt?: string;
  currentRound?: { attacker?: { points?: number; damages?: number }; defender?: { points?: number; damages?: number } };
}

export async function getActiveBattles(countryId: string | null): Promise<Battle[]> {
  const input: Record<string, unknown> = { isActive: true, limit: 30 };
  if (countryId) input.countryId = countryId;
  const data = await trpc<{ items?: Battle[] }>('battle.getBattles', input, 60_000);
  return data.items ?? [];
}

// ------------------------------------------------------------------ Spieler

interface SkillBar {
  currentBarValue?: number;
  total?: number;
  hourlyBarRegen?: number;
}

export interface UserLite {
  _id: string;
  username: string;
  country?: string;
  avatarUrl?: string;
  leveling?: { level?: number; dailyXpLeft?: number; availableSkillPoints?: number };
  skills?: Record<string, SkillBar | undefined>;
  militaryRank?: number;
}

export function getUser(userId: string, ttlMs = 2 * 60_000): Promise<UserLite> {
  return trpc<UserLite>('user.getUserLite', { userId }, ttlMs);
}

export async function searchUsers(name: string): Promise<UserLite[]> {
  const res = await trpc<{ userIds?: string[] }>('search.searchAnything', { searchText: name }, 60_000);
  const ids = (res.userIds ?? []).slice(0, 6);
  const users = await Promise.all(ids.map((id) => getUser(id, 10 * 60_000).catch(() => null)));
  return users.filter((u): u is UserLite => !!u);
}
