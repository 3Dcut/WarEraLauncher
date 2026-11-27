import { describe, it, expect } from 'vitest';
import {
  CASE_ODDS,
  CASE_CODES,
  codesOf,
  caseCodes,
  scrapBase,
  scrapYield,
  expectedScrap,
  toPull,
  matchOutcomes,
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
  type Pull,
} from '../src/cases/logic';
import { RARITIES, type Rarity, type Sale } from '../src/battle/logic';
import { fallbackRarity } from '../src/battle/logic';
import casesMessages from '../src/i18n/messages/cases';

const ME = 'u1';
let seq = 0;
const pull = (rarity: Rarity | null, extra: Partial<Pull> = {}): Pull => ({
  id: `p${++seq}`,
  itemId: `i${seq}`,
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

describe('toPull', () => {
  const rarityOf = (code: string) => fallbackRarity(code);
  const tx = (over: Record<string, unknown> = {}) => ({
    _id: 't1',
    transactionType: 'openCase',
    itemCode: 'case1',
    buyerId: ME,
    sellerId: ME,
    createdAt: '2026-11-27T00:30:41.971Z',
    item: { _id: 'item1', code: 'flask3', skills: { production: 17 } },
    ...over,
  });

  it('übernimmt rote und grüne Kisten mit Item-ID', () => {
    const p = toPull(tx({ item: { _id: 'item1', code: 'boots5', skills: { dodge: 33 } } }), ME, rarityOf);
    expect(p).toMatchObject({ id: 't1', itemId: 'item1', caseCode: 'case1', itemCode: 'boots5', rarity: 'legendary', skills: { dodge: 33 } });
  });

  it('übergeht Holzkisten, Werkzeugkästen und fremde Spieler', () => {
    expect(toPull(tx({ itemCode: 'toolbox' }), ME, rarityOf)).toBeNull();
    expect(toPull(tx({ itemCode: 'woodenCase' }), ME, rarityOf)).toBeNull();
    expect(toPull(tx({ buyerId: 'x', sellerId: 'x' }), ME, rarityOf)).toBeNull();
    expect(toPull(tx({ transactionType: 'trading' }), ME, rarityOf)).toBeNull();
  });
});

describe('matchOutcomes', () => {
  it('erkennt Zerlegungen an der Item-ID und Verkäufe an Code, Werten und Erwerbszeit', () => {
    const a = pull('rare', { itemCode: 'rifle', itemId: 'A', skills: { attack: 80, criticalChance: 12 } });
    const b = pull('epic', { itemCode: 'boots4', itemId: 'B', skills: { dodge: 23 } });
    const c = pull('epic', { itemCode: 'boots4', itemId: 'C', skills: { dodge: 25 } });
    const out = matchOutcomes(
      [a, b, c],
      ME,
      [{ transactionType: 'dismantleItem', buyerId: ME, createdAt: '2026-11-27T01:00:00Z', quantity: 54, item: { _id: 'A' } }],
      [
        {
          transactionType: 'itemMarket',
          sellerId: ME,
          createdAt: '2026-11-27T02:00:00Z',
          money: 61.5,
          item: { _id: 'new', code: 'boots4', skills: { dodge: 25 }, lastAcquisitionAt: new Date(Date.parse(c.at) - 3).toISOString() },
        },
        // gleiche Werte, aber zu einer ganz anderen Zeit erworben: gehört nicht zur Sitzung
        {
          transactionType: 'itemMarket',
          sellerId: ME,
          createdAt: '2026-11-27T02:00:00Z',
          money: 50,
          item: { _id: 'old', code: 'boots4', skills: { dodge: 23 }, lastAcquisitionAt: '2026-11-01T00:00:00Z' },
        },
      ],
    );
    expect(out[a.id]).toEqual({ kind: 'scrapped', at: '2026-11-27T01:00:00Z', amount: 54 });
    expect(out[c.id]).toEqual({ kind: 'sold', at: '2026-11-27T02:00:00Z', amount: 61.5 });
    expect(out[b.id]).toBeUndefined();
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
