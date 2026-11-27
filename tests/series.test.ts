import { describe, it, expect } from 'vitest';
import { pickIndices, sampleIndices } from '../src/assist/series';

describe('sampleIndices', () => {
  it('lässt kurze Reihen unverändert', () => {
    expect(sampleIndices(0, 600)).toEqual([]);
    expect(sampleIndices(1, 600)).toEqual([0]);
    expect(sampleIndices(5, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('wählt bei langen Reihen genau `max` aufsteigende Indizes mit erstem und letztem Punkt', () => {
    for (const [n, max] of [
      [601, 600],
      [1000, 600],
      [41_641, 600],
      [250_001, 700],
    ] as const) {
      const idx = sampleIndices(n, max);
      expect(idx).toHaveLength(max);
      expect(idx[0]).toBe(0);
      expect(idx[idx.length - 1]).toBe(n - 1);
      for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
  });

  it('verteilt die Punkte gleichmäßig', () => {
    const idx = sampleIndices(10_001, 101);
    expect(idx[50]).toBe(5000);
    expect(idx[100]).toBe(10_000);
  });
});

describe('pickIndices', () => {
  it('nimmt die gewählten Werte und lässt vollständige Wahl unberührt', () => {
    const values = [10, 11, 12, 13, 14, 15];
    expect(pickIndices(values, [0, 2, 5])).toEqual([10, 12, 15]);
    const all = pickIndices(values, [0, 1, 2, 3, 4, 5]);
    expect(all).toEqual(values);
    expect(all).not.toBe(values);
  });

  it('nimmt bei einer kürzeren Reihe den letzten Wert', () => {
    expect(pickIndices([1, 2, 3], [0, 2, 4, 6])).toEqual([1, 3, 3, 3]);
  });
});
