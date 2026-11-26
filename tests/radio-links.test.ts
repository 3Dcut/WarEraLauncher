// Kurzlinks warera.de/r, /n, /a: Weiterleitungsseiten und Zuordnung zum Sender
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stationFromAlias } from '../src/radio/stations';

describe('Radio-Kurzlinks', () => {
  const expected = { r: 'war-era-de', n: 'warera-nachtwache', a: 'warera-azura' } as const;

  for (const [short, station] of Object.entries(expected)) {
    it(`/${short} leitet weiter und startet ${station}`, () => {
      const html = readFileSync(`public/${short}/index.html`, 'utf8');
      expect(html).toContain(`url=../?radio=${short}`);
      expect(html).toContain(`location.replace('../?radio=${short}')`);
      expect(stationFromAlias(short)).toBe(station);
    });
  }

  it('versteht Langformen und Sender-IDs, sonst nichts', () => {
    expect(stationFromAlias('Nachtwache')).toBe('warera-nachtwache');
    expect(stationFromAlias('war-era-de')).toBe('war-era-de');
    expect(stationFromAlias('x')).toBe(null);
    expect(stationFromAlias('')).toBe(null);
  });
});
