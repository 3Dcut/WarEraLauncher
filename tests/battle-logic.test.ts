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
  formatSkills,
  ELITE_ODDS,
  type Opening,
  type Rarity,
  type RawTransaction,
} from '../src/battle/logic';

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

  it('kennt deutsche Namen und Werte', () => {
    expect(itemInfo('boots3').name).toBe('Stiefel');
    expect(itemInfo('sniper').name).toBe('Scharfschützengewehr');
    expect(itemInfo('unbekannt').name).toBe('unbekannt');
    expect(formatSkills({ attack: 55, criticalChance: 10 })).toBe('Angriff 55 · Krit-Chance 10');
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
