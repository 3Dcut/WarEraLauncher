import { describe, it, expect } from 'vitest';
import {
  evaluate,
  duel,
  toOpening,
  makeBaseline,
  freshOpenings,
  fallbackRarity,
  rollEliteItem,
  itemInfo,
  ELITE_ODDS,
  ITEM_BASES,
  SKILLS,
  CASE_TYPES,
  RARITIES,
  TARGET,
  caseType,
  caseFromParam,
  toSale,
  estimateValue,
  balance,
  type Opening,
  type Sale,
  type Rarity,
  type RawTransaction,
} from '../src/battle/logic';
import battleMessages from '../src/i18n/messages/battle';

let seq = 0;
const op = (rarity: Rarity | null, at: string, code = 'helmet2'): Opening => ({
  id: `id${String(++seq).padStart(4, '0')}`,
  at,
  caseCode: 'case2',
  itemCode: code,
  rarity,
});
const t = (s: number) => new Date(Date.UTC(2026, 10, 25, 20, 0, s)).toISOString();

describe('duel', () => {
  it('die seltenere Kategorie gewinnt, gleiche Kategorie ist Gleichstand', () => {
    expect(duel(op('rare', t(1)), op('uncommon', t(2)))).toBe(0);
    expect(duel(op('uncommon', t(1)), op('mythic', t(2)))).toBe(1);
    expect(duel(op('epic', t(1)), op('epic', t(2)))).toBe(null);
  });

  it('unbekannte Items verlieren gegen jede Kategorie', () => {
    expect(duel(op(null, t(1)), op('common', t(2)))).toBe(1);
    expect(duel(op(null, t(1)), op(null, t(2)))).toBe(null);
  });
});

describe('evaluate', () => {
  it('paart die n-te Öffnung von A mit der n-ten von B und zählt Punkte', () => {
    const a = [op('rare', t(1)), op('uncommon', t(5)), op('epic', t(9))];
    const b = [op('uncommon', t(3)), op('uncommon', t(7)), op('legendary', t(11))];
    const s = evaluate(a, b, 3);
    expect(s.rounds.map((r) => r.winner)).toEqual([0, null, 1]);
    expect(s.points).toEqual([1, 1]);
    expect(s.winner).toBe(null);
    expect(s.turn).toBe(0);
  });

  it('beendet das Spiel beim Punkteziel und ignoriert spätere Öffnungen', () => {
    const a = [op('rare', t(1)), op('rare', t(5)), op('rare', t(9)), op('mythic', t(13))];
    const b = [op('uncommon', t(3)), op('uncommon', t(7)), op('uncommon', t(11)), op('uncommon', t(15))];
    const s = evaluate(a, b, 3);
    expect(s.winner).toBe(0);
    expect(s.points).toEqual([3, 0]);
    expect(s.rounds).toHaveLength(3);
    expect(s.waiting).toEqual([[], []]);
  });

  it('merkt sich überzählige Öffnungen und weiß, wer dran ist', () => {
    const a = [op('rare', t(1)), op('epic', t(2))];
    const b = [op('rare', t(3))];
    const s = evaluate(a, b, 3);
    expect(s.rounds).toHaveLength(1);
    expect(s.waiting[0]).toHaveLength(1);
    expect(s.turn).toBe(1);
    expect(evaluate([], [], 3).turn).toBe(0);
    expect(evaluate([], [op('rare', t(1))], 3).turn).toBe(0);
  });

  it('sortiert nach Serverzeit, auch wenn die Abfrage unsortiert kommt', () => {
    const late = op('mythic', t(20));
    const early = op('uncommon', t(2));
    const s = evaluate([late, early], [op('rare', t(4)), op('rare', t(25))], 3);
    expect(s.rounds[0].a.id).toBe(early.id);
    expect(s.rounds.map((r) => r.winner)).toEqual([1, 0]);
  });

  it('Punkteziel 1 entscheidet in der ersten Runde mit Sieger', () => {
    const s = evaluate([op('epic', t(1)), op('rare', t(3))], [op('epic', t(2)), op('mythic', t(4))], 1);
    expect(s.winner).toBe(1);
    expect(s.rounds).toHaveLength(2);
  });
});

describe('Transaktionen', () => {
  const user = '6af8d29846a24ac3d3d81acc';
  const tx: RawTransaction = {
    _id: '6b0772a0c8aa9a8d88ee9c3e',
    itemCode: 'case2',
    sellerId: user,
    buyerId: user,
    transactionType: 'openCase',
    item: { code: 'rifle', skills: { attack: 80, criticalChance: 12 } },
    createdAt: '2026-11-25T23:43:28.088Z',
  };

  it('liest eine openCase-Transaktion wie von der API geliefert', () => {
    const o = toOpening(tx, user, fallbackRarity);
    expect(o).toMatchObject({ id: tx._id, caseCode: 'case2', itemCode: 'rifle', rarity: 'rare', at: tx.createdAt });
  });

  it('verwirft fremde Spieler, andere Typen und Einträge ohne Item', () => {
    expect(toOpening(tx, '000000000000000000000000', fallbackRarity)).toBe(null);
    expect(toOpening({ ...tx, transactionType: 'trading' }, user, fallbackRarity)).toBe(null);
    expect(toOpening({ ...tx, item: null }, user, fallbackRarity)).toBe(null);
  });

  it('zählt nur, was nach dem Start dazukommt', () => {
    const old = [op('rare', t(1)), op('epic', t(2))];
    const base = makeBaseline(old);
    expect(base.since).toBe(t(2));
    const fresh = op('uncommon', t(5));
    // Gleicher Zeitstempel wie der Stand (mehrere Kisten auf einmal geöffnet), aber neue ID
    const sameMs = op('rare', t(2));
    const result = freshOpenings([...old, fresh, sameMs, op('rare', t(0))], base, []);
    expect(result.map((o) => o.id)).toEqual([sameMs.id, fresh.id]);
    expect(freshOpenings([fresh], base, [fresh])).toEqual([]);
  });

  it('ohne bisherige Öffnungen zählt alles', () => {
    const base = makeBaseline([]);
    expect(base.since).toBe(null);
    expect(freshOpenings([op('rare', t(1))], base, [])).toHaveLength(1);
  });
});

describe('Items', () => {
  it('leitet Seltenheiten aus dem Itemcode ab', () => {
    expect(fallbackRarity('helmet1')).toBe('common');
    expect(fallbackRarity('gloves4')).toBe('epic');
    expect(fallbackRarity('chest6')).toBe('mythic');
    expect(fallbackRarity('pickaxe3')).toBe('rare');
    expect(fallbackRarity('tank')).toBe('legendary');
    expect(fallbackRarity('scraps')).toBe(null);
  });

  it('hat für jedes Item, jeden Wert, jede Kiste und Seltenheit einen Text in jeder Sprache', () => {
    expect(itemInfo('boots3')).toEqual({ base: 'boots', emoji: '🥾' });
    expect(itemInfo('sniper').base).toBe('sniper');
    expect(itemInfo('unbekannt').base).toBe(null);
    const keys = [
      ...ITEM_BASES.map((b) => `battle.item.${b}`),
      ...SKILLS.map((k) => `battle.skill.${k}`),
      ...CASE_TYPES.map((c) => `battle.case.${c.key}`),
      ...RARITIES.map((r) => `battle.rarity.${r}`),
    ];
    for (const l of ['de', 'en', 'sv'] as const) {
      const dict = battleMessages[l] as Record<string, string>;
      for (const k of keys) expect(dict[k], `${l}: ${k}`).toBeTruthy();
    }
  });

  it('Demo-Würfel trifft die Quoten der roten Kiste', () => {
    expect(ELITE_ODDS.reduce((s, [, p]) => s + p, 0)).toBeCloseTo(1, 6);
    let x = 1;
    const rng = () => ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
    const counts: Record<string, number> = {};
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const item = rollEliteItem(rng);
      counts[item.rarity] = (counts[item.rarity] ?? 0) + 1;
      expect(fallbackRarity(item.code)).toBe(item.rarity);
    }
    expect(counts.common).toBeUndefined();
    expect(counts.uncommon / n).toBeGreaterThan(0.47);
    expect(counts.uncommon / n).toBeLessThan(0.53);
    expect(counts.epic / n).toBeGreaterThan(0.13);
    expect(counts.epic / n).toBeLessThan(0.17);
  });
});

describe('Kisten und Format', () => {
  it('spielt offiziell rote Kisten im Format FT3, grün nur auf Wunsch', () => {
    expect(TARGET).toBe(3);
    expect(caseType(null).code).toBe('case2');
    expect(caseType('case1').key).toBe('green');
    expect(caseFromParam('grün')).toBe('case1');
    expect(caseFromParam('Red')).toBe('case2');
    expect(caseFromParam('holz')).toBe(null);
  });
});

describe('Bilanz', () => {
  const sale = (price: number, skills: Record<string, number>, minute: number): Sale => ({
    id: `s${minute}`,
    at: new Date(Date.UTC(2026, 10, 26, 22, minute)).toISOString(),
    price,
    skills,
  });
  // Ausschnitt echter Verkäufe von boots5 (Ausweichen 31–40), neueste zuerst
  const boots = [
    sale(194.3, { dodge: 37 }, 59),
    sale(160, { dodge: 31 }, 58),
    sale(193, { dodge: 36 }, 57),
    sale(175, { dodge: 33 }, 56),
    sale(219, { dodge: 40 }, 55),
    sale(156, { dodge: 31 }, 54),
    sale(210, { dodge: 39 }, 53),
    sale(159.99, { dodge: 31 }, 52),
  ];
  const range = { dodge: [31, 40] as [number, number] };

  it('liest Verkäufe vom Itemmarkt und lässt Abgenutztes und Fremdes weg', () => {
    const tx: RawTransaction = {
      _id: 'x1',
      transactionType: 'itemMarket',
      createdAt: '2026-11-27T00:08:23.529Z',
      money: 159.992,
      quantity: 1,
      marketAvgPrice: 183.88,
      item: { code: 'boots5', skills: { dodge: 31 }, state: 100, maxState: 100 },
    };
    expect(toSale(tx)).toEqual({ id: 'x1', at: tx.createdAt, price: 159.992, skills: { dodge: 31 }, avg: 183.88 });
    expect(toSale({ ...tx, item: { ...tx.item, state: 60 } })).toBe(null);
    expect(toSale({ ...tx, transactionType: 'openCase' })).toBe(null);
    expect(toSale({ ...tx, money: 0 })).toBe(null);
    expect(toSale({ ...tx, quantity: 2, money: 10 })?.price).toBe(5);
  });

  it('nimmt bei identischem Wurf den Median der gleichen Verkäufe', () => {
    expect(estimateValue({ dodge: 31 }, boots, range)).toEqual({ price: 159.99, basis: 'identical', samples: 3 });
  });

  it('weicht ohne identischen Wurf auf die nächsten Werte aus', () => {
    const v = estimateValue({ dodge: 38 }, boots, range)!;
    expect(v.basis).toBe('similar');
    expect(v.price).toBeGreaterThan(190);
    expect(v.price).toBeLessThan(215);
  });

  it('gewichtet bei Waffen beide Werte über ihre Spanne', () => {
    const jets = [
      sale(785, { attack: 291, criticalChance: 50 }, 50),
      sale(460, { attack: 265, criticalChance: 43 }, 49),
      sale(466, { attack: 294, criticalChance: 41 }, 48),
      sale(470, { attack: 262, criticalChance: 44 }, 47),
      sale(455, { attack: 268, criticalChance: 42 }, 46),
    ];
    const v = estimateValue({ attack: 266, criticalChance: 43 }, jets, { attack: [221, 300], criticalChance: [41, 50] })!;
    expect(v.price).toBe(460);
  });

  it('kommt ohne Spielkonfiguration mit den Spannen aus den Verkäufen aus', () => {
    expect(estimateValue({ dodge: 40 }, boots, null)?.basis).toBe('similar');
    expect(estimateValue({ dodge: 31 }, [], range)).toBe(null);
  });

  it('rechnet Einsatz, Beute und Bilanz über die gewerteten Öffnungen', () => {
    const a = op('legendary', t(1), 'boots5');
    const b = op('rare', t(2), 'helmet3');
    const values = { [a.id]: { price: 160, basis: 'identical' as const, samples: 3 } };
    expect(balance([a, b], 29.88, values)).toEqual({ opened: 2, cost: 59.76, loot: 160, missing: 1, net: 160 - 59.76 });
    expect(balance([a], null, values).net).toBe(null);
    expect(balance([], 29.88, {})).toEqual({ opened: 0, cost: 0, loot: 0, missing: 0, net: 0 });
  });
});
