import { describe, it, expect } from 'vitest';
import {
  CASE_ODDS,
  CASE_CODES,
  codesOf,
  caseCodes,
  scrapBase,
  scrapYield,
  expectedScrap,
  sellThreshold,
  advise,
  rollGrid,
  valueCode,
  valueCase,
  caseVerdict,
  luckScore,
  luckPercentile,
  binomialTail,
  rarityStats,
  sinceLast,
  longestDrought,
  chanceAtLeast,
  recentAverage,
  rarityStatsFromCounts,
  sinceFor,
  dayStart,
  priceIndex,
  priceOn,
  drawMoments,
  normalCdf,
  luckNormal,
  LUCK_SIMULATION_MAX,
  type Pull,
} from '../src/cases/logic';
import { RARITIES, type Rarity, type Sale } from '../src/battle/logic';
import { fallbackRarity } from '../src/battle/logic';
import casesMessages from '../src/i18n/messages/cases';

let seq = 0;
const pull = (rarity: Rarity | null, extra: Partial<Pull> = {}): Pull => ({
  id: `p${++seq}`,
  at: new Date(Date.UTC(2026, 10, 27, 0, 0, seq)).toISOString(),
  caseCode: 'case2',
  itemCode: 'helmet2',
  rarity,
  skills: {},
  cost: 30,
  ...extra,
});

describe('Quoten', () => {
  it('summieren sich je Kiste zu 100 %', () => {
    for (const c of CASE_CODES) expect(RARITIES.reduce((s, r) => s + CASE_ODDS[c][r], 0)).toBeCloseTo(1, 10);
  });

  it('verteilen jede Seltenheit zu 30 % auf die Waffe und gleich auf fünf Ausrüstungsplätze', () => {
    for (const r of RARITIES) {
      const codes = codesOf(r);
      expect(codes.reduce((s, c) => s + c.p, 0)).toBeCloseTo(1, 10);
      expect(codes[0].p).toBeCloseTo(0.3, 10);
      for (const c of codes) expect(fallbackRarity(c.code)).toBe(r);
    }
  });

  it('kennen für rote Kisten keine gewöhnlichen Items', () => {
    expect(caseCodes('case2')).not.toContain('knife');
    expect(caseCodes('case1')).toContain('knife');
    expect(caseCodes('case1')).toHaveLength(36);
  });
});

describe('Schrott', () => {
  it('bringt bei vollem Zustand 6 · 3^Stufe', () => {
    expect(RARITIES.map((r) => scrapBase(r))).toEqual([6, 18, 54, 162, 486, 1458]);
    expect(RARITIES.map((r) => scrapYield(r))).toEqual([6, 18, 54, 162, 486, 1458]);
  });

  it('trifft die abgelesenen Werte abgenutzter Items', () => {
    // aus echten dismantleItem-Transaktionen (2026-11-27)
    expect(scrapYield('common', 0)).toBe(2);
    expect(scrapYield('common', 26)).toBe(3);
    expect(scrapYield('common', 85)).toBe(5);
    expect(scrapYield('uncommon', 21)).toBe(8);
    expect(scrapYield('uncommon', 86.6)).toBe(16);
    expect(scrapYield('uncommon', 38.8)).toBe(10);
    expect(scrapYield('rare', 44)).toBe(33);
    expect(scrapYield('rare', 82.4)).toBe(47);
    expect(scrapYield('rare', 89)).toBe(50);
    expect(scrapYield('epic', 27)).toBe(83);
    expect(scrapYield('legendary', 4)).toBe(174);
    expect(scrapYield('legendary', 1)).toBe(165);
    expect(scrapYield(null)).toBe(0);
  });

  it('erwartet je Kiste 14,67 (grün) bzw. 70,02 (rot) Schrott', () => {
    expect(expectedScrap('case1')).toBeCloseTo(14.6712, 3);
    expect(expectedScrap('case2')).toBeCloseTo(70.02, 2);
  });
});

describe('Empfehlung', () => {
  it('verlangt beide Schwellen: Prozent und festen Betrag', () => {
    expect(sellThreshold(10, { pct: 15, abs: 1 })).toBeCloseTo(11.5);
    expect(sellThreshold(2, { pct: 15, abs: 1 })).toBeCloseTo(3);
    expect(sellThreshold(10, { pct: 0, abs: 0 })).toBe(10);
  });

  it('verkauft nur, was die Schwelle erreicht, und rechnet sonst mit Schrott', () => {
    const scrapPrice = 0.25; // episch: 162 Schrott = 40,50
    const m = { pct: 15, abs: 1 };
    expect(advise('epic', 46, scrapPrice, m)).toMatchObject({ action: 'scrap', value: 40.5, scrapUnits: 162 });
    expect(advise('epic', 47, scrapPrice, m)).toMatchObject({ action: 'sell', value: 47 });
    expect(advise('epic', null, scrapPrice, m)).toMatchObject({ action: 'scrap', sale: null });
  });
});

describe('Erwartungswert', () => {
  it('legt ein Gitter gleichverteilter Würfe über die Spannen', () => {
    expect(rollGrid(null)).toEqual([{}]);
    expect(rollGrid({ dodge: [31, 40] })).toHaveLength(6);
    expect(rollGrid({ attack: [221, 300], criticalChance: [41, 50] })).toHaveLength(36);
    expect(rollGrid({ dodge: [1, 3] })).toEqual([{ dodge: 1 }, { dodge: 2 }, { dodge: 3 }]);
  });

  it('bewertet einen Code als Mittel über die Würfe', () => {
    const sales: Sale[] = [31, 33, 35, 37, 39, 40].map((dodge, i) => ({ id: `s${i}`, at: `2026-11-27T00:0${i}:00Z`, price: dodge * 4, skills: { dodge } }));
    const v = valueCode('legendary', sales, { dodge: [31, 40] }, 0.25, { pct: 15, abs: 1 });
    expect(v.sale).toBeGreaterThan(124);
    expect(v.sale).toBeLessThan(160);
    // Schrott 486 · 0,25 = 121,50, Schwelle 139,73: nur die besseren Würfe lohnen
    expect(v.sellShare).toBeGreaterThan(0);
    expect(v.sellShare).toBeLessThan(1);
  });

  it('fällt ohne Marktdaten auf den Schrottwert zurück', () => {
    const v = valueCase('case2', () => null, 0.25);
    expect(v.ev).toBeCloseTo(v.scrapEv, 10);
    expect(v.coverage).toBe(0);
    expect(v.sd).toBeGreaterThan(0);
  });

  it('rät zum Kauf über dem Briefkurs und zum Verkauf unter dem Geldkurs', () => {
    expect(caseVerdict(32, 29, 30)).toBe('buy');
    expect(caseVerdict(21, 29.5, 30)).toBe('sell');
    expect(caseVerdict(29.7, 29.5, 30)).toBe('open');
  });
});

describe('Glück', () => {
  it('liegt bei einer durchschnittlichen Sitzung um die Mitte', () => {
    const n = 200;
    const mean = expectedScrap('case2') * n;
    const p = luckPercentile({ case1: 0, case2: n }, Math.round(mean), 2000)!;
    expect(p).toBeGreaterThan(0.35);
    expect(p).toBeLessThan(0.75);
  });

  it('erkennt Ausreißer nach oben und unten', () => {
    expect(luckPercentile({ case1: 0, case2: 100 }, 100 * 18, 1000)).toBeLessThan(0.01);
    expect(luckPercentile({ case1: 0, case2: 100 }, 100 * 486, 1000)).toBeGreaterThan(0.99);
    expect(luckPercentile({ case1: 0, case2: 0 }, 0)).toBeNull();
  });

  it('ist bei gleicher Eingabe reproduzierbar', () => {
    const a = luckPercentile({ case1: 30, case2: 20 }, 2000, 500);
    expect(luckPercentile({ case1: 30, case2: 20 }, 2000, 500)).toBe(a);
  });

  it('zählt Schrott-Einheiten', () => {
    expect(luckScore([{ rarity: 'rare' }, { rarity: 'mythic' }, { rarity: null }])).toBe(54 + 1458);
  });

  it('rechnet Binomialschwänze', () => {
    expect(binomialTail(10, 5, 0.5, 'atLeast')).toBeCloseTo(0.623046875, 9);
    expect(binomialTail(10, 2, 0.5, 'atMost')).toBeCloseTo(0.0546875, 9);
    expect(binomialTail(1000, 0, 0.005, 'atMost')).toBeCloseTo(0.995 ** 1000, 9);
  });

  it('vergleicht Seltenheiten mit der Erwartung gemischter Sitzungen', () => {
    const list = [...Array(10)].map(() => pull('uncommon', { caseCode: 'case1' })).concat([...Array(10)].map(() => pull('rare')));
    const stats = rarityStats(list);
    const unc = stats.find((s) => s.rarity === 'uncommon')!;
    expect(unc.count).toBe(10);
    expect(unc.expected).toBeCloseTo(10 * 0.3 + 10 * 0.5, 10);
    expect(stats.find((s) => s.rarity === 'common')!.expected).toBeCloseTo(6.2, 10);
  });

  it('misst Durststrecken', () => {
    const list = ['rare', 'epic', 'rare', 'uncommon', 'rare', 'legendary', 'rare', 'rare'].map((r) => ({ rarity: r as Rarity }));
    expect(sinceLast(list, 'epic')).toBe(2);
    expect(longestDrought(list, 'epic')).toBe(3);
    expect(sinceLast([{ rarity: 'rare' }], 'mythic')).toBe(1);
    expect(chanceAtLeast('case2', 'epic')).toBeCloseTo(0.18, 10);
  });
});

describe('recentAverage', () => {
  it('gewichtet nach Menge und lässt den laufenden Tag weg', () => {
    const days = [
      { avgValue: 10, totalQuantity: 100 },
      { avgValue: 20, totalQuantity: 300 },
      { avgValue: 999, totalQuantity: 1 },
    ];
    expect(recentAverage(days)).toEqual({ avg: 17.5, volume: 200 });
    expect(recentAverage([])).toEqual({ avg: null, volume: null });
  });
});

describe('Texte', () => {
  it('haben für jede Seltenheitsrichtung und jeden Zeitraum einen Eintrag', () => {
    for (const l of ['de', 'en', 'sv'] as const) {
      const dict = casesMessages[l] as Record<string, string>;
      for (const k of [
        'cases.since.now',
        'cases.since.1h',
        'cases.since.24h',
        'cases.market.verdict.buy',
        'cases.market.verdict.sell',
        'cases.market.verdict.open',
        'cases.market.scrap.sell',
        'cases.market.scrap.hold',
        'cases.market.scrap.neutral',
      ])
        expect(dict[k], `${l}: ${k}`).toBeTruthy();
    }
  });
});

describe('Zeiträume', () => {
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);

  it('rechnen feste Spannen zurück und kennen für „jetzt“ und „alles“ keine Grenze', () => {
    expect(sinceFor('1h', now)).toBe('2026-11-27T11:00:00.000Z');
    expect(sinceFor('24h', now)).toBe('2026-11-26T12:00:00.000Z');
    expect(sinceFor('7d', now)).toBe('2026-11-20T12:00:00.000Z');
    expect(sinceFor('30d', now)).toBe('2026-10-28T12:00:00.000Z');
    expect(sinceFor('all', now)).toBeNull();
    expect(sinceFor('now', now)).toBeNull();
  });

  it('beginnen ein Datum um Mitternacht Ortszeit und begrenzen die Zukunft auf jetzt', () => {
    expect(sinceFor('date', now, '2026-11-20')).toBe(new Date(2026, 10, 20).toISOString());
    expect(sinceFor('date', now, '2099-01-01')).toBe(new Date(now).toISOString());
    expect(sinceFor('date', now, '')).toBeNull();
    expect(sinceFor('date', now, 'gestern')).toBeNull();
  });

  it('prüft Datumseingaben streng', () => {
    expect(dayStart('2026-02-28')).toBe(new Date(2026, 1, 28).getTime());
    expect(dayStart('2026-02-31')).toBeNull();
    expect(dayStart('2026-13-01')).toBeNull();
    expect(dayStart('27.11.2026')).toBeNull();
    expect(dayStart(null)).toBeNull();
  });
});

describe('Tagespreise', () => {
  const days = (rows: [string, number | undefined][]) => priceIndex(rows.map(([d, avgValue]) => ({ valueAt: `${d}T00:00:00.000Z`, avgValue })));
  const idx = days([
    ['2026-11-24', 3.9],
    ['2026-11-25', 3.95],
    ['2026-11-27', 4.1],
  ]);

  it('nimmt das Tagesmittel des Tages der Öffnung', () => {
    expect(priceOn(idx, '2026-11-25T08:15:00.000Z')).toBe(3.95);
    expect(priceOn(idx, '2026-11-27T23:59:59.999Z')).toBe(4.1);
  });

  it('nimmt für Tage ohne Handel den letzten Tag davor', () => {
    expect(priceOn(idx, '2026-11-26T10:00:00.000Z')).toBe(3.95);
    expect(priceOn(idx, '2026-12-05T00:00:00.000Z')).toBe(4.1);
  });

  it('nimmt für Zeiten vor dem Verlauf den ältesten Tag und kennt ohne Verlauf nichts', () => {
    expect(priceOn(idx, '2026-10-01T00:00:00.000Z')).toBe(3.9);
    expect(priceOn(priceIndex([]), '2026-11-25T00:00:00.000Z')).toBeNull();
    expect(priceOn(priceIndex(undefined), '2026-11-25T00:00:00.000Z')).toBeNull();
  });

  it('lässt Tage ohne Mittel aus und sortiert unsortierte Eingaben', () => {
    const odd = days([
      ['2026-11-26', 5],
      ['2026-11-24', 4],
      ['2026-11-25', undefined],
    ]);
    expect(odd.days).toEqual(['2026-11-24', '2026-11-26']);
    expect(priceOn(odd, '2026-11-25T12:00:00.000Z')).toBe(4);
  });
});

describe('Glück bei sehr vielen Kisten', () => {
  it('kennt Mittelwert und Varianz einer Ziehung', () => {
    for (const c of CASE_CODES) {
      const m = drawMoments(c);
      expect(m.mean).toBeCloseTo(expectedScrap(c), 10);
      expect(m.variance).toBeGreaterThan(0);
      expect(m.third).toBeGreaterThan(0); // rechtsschief: seltene Items bringen sehr viel Schrott
    }
  });

  it('rechnet die Normalverteilung auf sieben Stellen genau', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 6);
    expect(normalCdf(-8)).toBeLessThan(1e-12);
    expect(normalCdf(8)).toBeGreaterThan(1 - 1e-12);
  });

  it('liegt mit der Erwartung als Ergebnis nahe der Mitte und ordnet Ausreißer richtig ein', () => {
    const counts = { case1: 30_000, case2: 0 };
    const mean = counts.case1 * drawMoments('case1').mean;
    const sd = Math.sqrt(counts.case1 * drawMoments('case1').variance);
    expect(luckNormal(counts, mean)!).toBeGreaterThan(0.48);
    expect(luckNormal(counts, mean)!).toBeLessThan(0.52);
    expect(luckNormal(counts, mean + 3 * sd)!).toBeGreaterThan(0.99);
    expect(luckNormal(counts, mean - 3 * sd)!).toBeLessThan(0.01);
    expect(luckNormal({ case1: 0, case2: 0 }, 0)).toBeNull();
  });

  it('stimmt oberhalb der Simulationsgrenze mit der Simulation überein', () => {
    const counts = { case1: LUCK_SIMULATION_MAX + 1500, case2: 400 };
    const mean = counts.case1 * drawMoments('case1').mean + counts.case2 * drawMoments('case2').mean;
    const sd = Math.sqrt(counts.case1 * drawMoments('case1').variance + counts.case2 * drawMoments('case2').variance);
    for (const z of [-1.5, -0.5, 0, 0.5, 1.5]) {
      const score = Math.round(mean + z * sd);
      const simulated = luckPercentile(counts, score, 1500)!;
      expect(Math.abs(luckNormal(counts, score)! - simulated), `z=${z}`).toBeLessThan(0.05);
    }
  });

  it('nimmt oberhalb der Grenze die Näherung, darunter und mit ausdrücklicher Zahl die Simulation', () => {
    const big = { case1: LUCK_SIMULATION_MAX + 1, case2: 0 };
    const score = Math.round(big.case1 * drawMoments('case1').mean);
    expect(luckPercentile(big, score)).toBe(luckNormal(big, score));
    expect(luckPercentile(big, score, 300)).not.toBe(luckNormal(big, score));
    const small = { case1: 500, case2: 0 };
    expect(luckPercentile(small, 7000)).toBe(luckPercentile(small, 7000, Math.max(300, Math.min(4000, Math.floor(3_000_000 / 500)))));
  });
});

describe('rarityStatsFromCounts', () => {
  it('liefert dieselbe Tabelle wie die Liste, nur aus Zählwerten', () => {
    const list = [...Array(120)].map((_, i) => pull(i % 7 === 0 ? 'rare' : i % 3 === 0 ? 'epic' : 'uncommon', { caseCode: i % 4 === 0 ? 'case2' : 'case1' }));
    const byRarity = [0, 0, 0, 0, 0, 0];
    const counts = { case1: 0, case2: 0 };
    for (const p of list) {
      counts[p.caseCode]++;
      byRarity[RARITIES.indexOf(p.rarity!)]++;
    }
    expect(rarityStatsFromCounts(counts, byRarity)).toEqual(rarityStats(list));
  });
});
