// Reine Auswertung des Marktchecks, ohne DOM und Netz: eigene Orders gegen Orderbuch, Tagesumsatz
// und bisherige Füllungen; Ausrüstungsverkäufe nach Dauer und Preis.
//
// Datenlage (geprüft 2026-11-27): tradingOrder.getPublicOrdersByOwner liefert die offenen Orders auf
// Waren, Kisten und Schrott. Eigene Ausrüstungsangebote (itemOffer.getItemOffers) sperrt WarEra für
// API-Schlüssel; abgeschlossene Ausrüstungsverkäufe stehen in den itemMarket-Transaktionen und tragen
// den Zeitpunkt des Angebots (offerCreatedAt) sowie den Durchschnittspreis beim Verkauf (marketAvgPrice).

export interface Order {
  _id: string;
  user?: string;
  itemCode: string;
  quantity: number;
  price: number;
  offerAt?: string;
  type: 'buy' | 'sell';
}

export interface Fill {
  at: string;
  quantity: number;
  money: number;
}

export interface TradeTx {
  _id?: string;
  transactionType?: string;
  itemCode?: string;
  quantity?: number;
  money?: number;
  sellerId?: string;
  buyerId?: string;
  offerCreatedAt?: string;
  createdAt?: string;
}

/** Füllungen einer eigenen Order: Handel mit derselben Ware, gleiche Seite, gleicher Angebotszeitpunkt. */
export function fillsOf(order: Order, userId: string, trades: TradeTx[]): Fill[] {
  if (!order.offerAt) return [];
  return trades
    .filter(
      (tx) =>
        tx.transactionType === 'trading' &&
        tx.itemCode === order.itemCode &&
        tx.offerCreatedAt === order.offerAt &&
        (order.type === 'sell' ? tx.sellerId === userId : tx.buyerId === userId) &&
        !!tx.createdAt,
    )
    .map((tx) => ({ at: tx.createdAt!, quantity: tx.quantity ?? 0, money: tx.money ?? 0 }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

export type Flag = 'expensive' | 'cheap' | 'stale' | 'flooding' | 'outbid' | 'overbid';

export interface OrderCheck {
  order: Order;
  /** Bester Preis anderer auf derselben Seite (günstigster Verkäufer bzw. höchster Käufer). */
  bestOther: number | null;
  /** Bester Preis der Gegenseite. */
  opposite: number | null;
  /** Wie viele fremde Orders vor dieser stehen und wie viel Menge sie haben. */
  ahead: number;
  aheadQty: number;
  /** Abstand zum besten fremden Preis, relativ (positiv: teurer als der günstigste Verkäufer bzw. unter dem besten Käufer). */
  gap: number | null;
  /** Preis gegenüber dem Mittel der letzten sieben Tage. */
  vsAvg: number | null;
  avg7: number | null;
  volume7: number | null;
  /** Tage, bis Menge vor dieser Order plus eigene Menge beim üblichen Umsatz abverkauft wäre (nur Verkauf). */
  reach: number | null;
  /** Anteil der eigenen Menge an der sichtbaren Menge dieser Seite. */
  share: number | null;
  ageH: number | null;
  filled: number;
  lastFillAt: string | null;
  flags: Flag[];
  /** Preisvorschlag, null wenn die Order gut steht. */
  suggestion: number | null;
}

export interface CheckInput {
  order: Order;
  userId: string;
  book: { buy: Order[]; sell: Order[] } | null;
  avg7: number | null;
  volume7: number | null;
  fills: Fill[];
  now: number;
}

export const TICK = 0.001;
const round = (v: number) => Math.round(v / TICK) * TICK;

export function checkOrder({ order, userId, book, avg7, volume7, fills, now }: CheckInput): OrderCheck {
  const side = order.type === 'sell' ? (book?.sell ?? []) : (book?.buy ?? []);
  const oppositeSide = order.type === 'sell' ? (book?.buy ?? []) : (book?.sell ?? []);
  const others = side.filter((o) => o.user !== userId && o._id !== order._id);
  const better = (o: Order) =>
    order.type === 'sell'
      ? o.price < order.price || (o.price === order.price && (o.offerAt ?? '') < (order.offerAt ?? ''))
      : o.price > order.price || (o.price === order.price && (o.offerAt ?? '') < (order.offerAt ?? ''));
  const aheadList = others.filter(better);
  const prices = others.map((o) => o.price);
  const bestOther = prices.length ? (order.type === 'sell' ? Math.min(...prices) : Math.max(...prices)) : null;
  const opposite = oppositeSide.length ? oppositeSide[0].price : null;
  const gap = bestOther === null ? null : order.type === 'sell' ? order.price / bestOther - 1 : 1 - order.price / bestOther;
  const vsAvg = avg7 ? order.price / avg7 - 1 : null;
  const aheadQty = aheadList.reduce((s, o) => s + o.quantity, 0);
  const visible = side.reduce((s, o) => s + o.quantity, 0) + (side.some((o) => o._id === order._id) ? 0 : order.quantity);
  const reach = order.type === 'sell' && volume7 ? (aheadQty + order.quantity) / volume7 : null;
  const share = visible ? order.quantity / visible : null;
  const offered = order.offerAt ? Date.parse(order.offerAt) : NaN;
  const ageH = Number.isFinite(offered) ? (now - offered) / 3600_000 : null;
  const lastFillAt = fills[0]?.at ?? null;
  const filled = fills.reduce((s, f) => s + f.quantity, 0);
  const sinceFillH = lastFillAt ? (now - Date.parse(lastFillAt)) / 3600_000 : ageH;

  const flags: Flag[] = [];
  let suggestion: number | null = null;
  if (order.type === 'sell') {
    // Teuer: andere sind günstiger und der Preis liegt spürbar über Markt oder Mittel
    if (aheadList.length && ((gap ?? 0) > 0.03 || (vsAvg ?? 0) > 0.05)) flags.push('expensive');
    // Billig: ganz vorne mit deutlichem Abstand zum nächsten Verkäufer
    if (!aheadList.length && gap !== null && gap < -0.03) flags.push('cheap');
    if (volume7 && (order.quantity > 2 * volume7 || ((share ?? 0) > 0.5 && order.quantity > volume7 * 0.5))) flags.push('flooding');
    if (bestOther !== null && (flags.includes('expensive') || flags.includes('cheap'))) suggestion = round(Math.max(TICK, bestOther - TICK));
  } else {
    if (aheadList.length) flags.push('outbid');
    if (!aheadList.length && gap !== null && gap < -0.03) flags.push('overbid');
    if (bestOther !== null && flags.length) suggestion = round(bestOther + TICK);
    // Nicht über den günstigsten Verkäufer bieten
    if (suggestion !== null && opposite !== null && suggestion >= opposite) suggestion = round(opposite - TICK);
  }
  // Ein Vorschlag, der nichts ändert (etwa weil der Abstand zur Gegenseite nur einen Tick beträgt), entfällt
  if (suggestion !== null && Math.abs(suggestion - order.price) < TICK / 2) suggestion = null;
  if (ageH !== null && ageH > 48 && (sinceFillH ?? 0) > 24) flags.push('stale');
  return {
    order,
    bestOther,
    opposite,
    ahead: aheadList.length,
    aheadQty,
    gap,
    vsAvg,
    avg7,
    volume7,
    reach,
    share,
    ageH,
    filled,
    lastFillAt,
    flags,
    suggestion,
  };
}

// ------------------------------------------------------------------ Ausrüstungsverkäufe

export interface EquipSale {
  id: string;
  at: string;
  code: string;
  price: number;
  /** Minuten vom Angebot bis zum Verkauf. */
  minutes: number | null;
  /** Preis gegenüber dem Durchschnitt des Codes beim Verkauf. */
  premium: number | null;
  skills: Record<string, number>;
}

export interface EquipTx extends TradeTx {
  marketAvgPrice?: number;
  item?: { code?: string; skills?: Record<string, number> } | null;
}

/** `fallbackAvg`: aktueller Durchschnitt des Codes für ältere Verkäufe, die noch keinen marketAvgPrice tragen. */
export function toEquipSale(tx: EquipTx, userId: string, fallbackAvg?: number | null): EquipSale | null {
  if (tx.transactionType !== 'itemMarket' || tx.sellerId !== userId || !tx._id || !tx.createdAt) return null;
  const code = tx.item?.code ?? tx.itemCode;
  const price = typeof tx.money === 'number' ? tx.money / Math.max(1, tx.quantity ?? 1) : NaN;
  if (!code || !Number.isFinite(price) || price <= 0) return null;
  const offered = tx.offerCreatedAt ? Date.parse(tx.offerCreatedAt) : NaN;
  const minutes = Number.isFinite(offered) ? Math.max(0, (Date.parse(tx.createdAt) - offered) / 60_000) : null;
  const avg = tx.marketAvgPrice && tx.marketAvgPrice > 0 ? tx.marketAvgPrice : fallbackAvg && fallbackAvg > 0 ? fallbackAvg : null;
  const premium = avg ? price / avg - 1 : null;
  return { id: tx._id, at: tx.createdAt, code, price, minutes, premium, skills: tx.item?.skills ?? {} };
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface SalesSummary {
  count: number;
  revenue: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  /** Anteil, der innerhalb einer Stunde wegging. */
  withinHour: number | null;
  medianPremium: number | null;
  /** Tage zwischen erstem und letztem Verkauf (mindestens einer). */
  days: number;
}

export function summarize(sales: EquipSale[]): SalesSummary {
  const minutes = sales.map((s) => s.minutes).filter((m): m is number => m !== null);
  const premiums = sales.map((s) => s.premium).filter((p): p is number => p !== null);
  const times = sales.map((s) => Date.parse(s.at)).filter(Number.isFinite);
  const days = times.length > 1 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86_400_000) : 1;
  return {
    count: sales.length,
    revenue: sales.reduce((s, x) => s + x.price, 0),
    medianMinutes: quantile(minutes, 0.5),
    p90Minutes: quantile(minutes, 0.9),
    withinHour: minutes.length ? minutes.filter((m) => m <= 60).length / minutes.length : null,
    medianPremium: quantile(premiums, 0.5),
    days,
  };
}

/** Verkäufe nach Preislage: deutlich unter, um und über dem Durchschnitt, je mit mittlerer Dauer. */
export function premiumBands(sales: EquipSale[]): { band: 'below' | 'around' | 'above'; count: number; medianMinutes: number | null }[] {
  const bands = { below: [] as EquipSale[], around: [] as EquipSale[], above: [] as EquipSale[] };
  for (const s of sales) {
    if (s.premium === null) continue;
    bands[s.premium < -0.1 ? 'below' : s.premium > 0.1 ? 'above' : 'around'].push(s);
  }
  return (['below', 'around', 'above'] as const).map((band) => ({
    band,
    count: bands[band].length,
    medianMinutes: quantile(
      bands[band].map((s) => s.minutes).filter((m): m is number => m !== null),
      0.5,
    ),
  }));
}

// ------------------------------------------------------------------ Preis prüfen

/** Lage eines Preises unter den jüngsten Verkäufen: Anteil der Verkäufe, die billiger waren. */
export function pricePercentile(price: number, prices: number[]): number | null {
  if (!prices.length) return null;
  const below = prices.filter((p) => p < price).length;
  const equal = prices.filter((p) => p === price).length;
  return (below + equal / 2) / prices.length;
}

/** Verkäufe je Tag im Fenster der vorliegenden Verkäufe. */
export function salesPerDay(times: string[]): number | null {
  const t = times.map((x) => Date.parse(x)).filter(Number.isFinite);
  if (t.length < 2) return null;
  const span = (Math.max(...t) - Math.min(...t)) / 86_400_000;
  return span > 0 ? t.length / span : null;
}
