// Prüft die Wörterbücher: gleiche Schlüssel, gleiche Platzhalter, keine leeren Texte,
// vollständige Mehrzahlformen und mehrsprachige Einträge in den Datendateien.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATALOGS, localized, localizedUrl, allVariants, type Lang } from '../src/i18n';

const LANGS: Lang[] = ['de', 'en', 'sv'];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('Wörterbücher', () => {
  it('haben in jeder Sprache dieselben Schlüssel', () => {
    for (const c of CATALOGS) {
      const keys = Object.keys(c.de).sort();
      for (const l of LANGS) expect(Object.keys(c[l]).sort(), l).toEqual(keys);
    }
  });

  it('vergeben jeden Schlüssel nur einmal und mit dem Präfix ihres Bereichs', () => {
    const seen = new Map<string, number>();
    CATALOGS.forEach((c, i) => {
      const keys = Object.keys(c.de);
      const prefix = keys[0]?.split('.')[0];
      for (const k of keys) {
        expect(seen.has(k), `doppelt: ${k}`).toBe(false);
        expect(k.split('.')[0], `${k} gehört nicht zu ${prefix}`).toBe(prefix);
        seen.set(k, i);
      }
    });
  });

  it('nutzen in allen Sprachen dieselben Platzhalter', () => {
    for (const c of CATALOGS) {
      for (const [k, de] of Object.entries(c.de) as [string, string][]) {
        for (const l of ['en', 'sv'] as const) {
          const other = (c[l] as Record<string, string>)[k];
          expect(placeholders(other), `${l}: ${k}`).toEqual(placeholders(de));
        }
      }
    }
  });

  it('enthalten keine leeren Texte', () => {
    for (const c of CATALOGS) for (const l of LANGS) for (const [k, v] of Object.entries(c[l])) expect(String(v).trim(), `${l}: ${k}`).not.toBe('');
  });

  it('haben zu jeder Mehrzahl auch die Einzahl', () => {
    for (const c of CATALOGS) {
      const keys = new Set(Object.keys(c.de));
      for (const k of keys) {
        if (k.endsWith('.other')) expect(keys.has(k.replace(/\.other$/, '.one')), k).toBe(true);
        if (k.endsWith('.one')) expect(keys.has(k.replace(/\.one$/, '.other')), k).toBe(true);
      }
    }
  });
});

describe('mehrsprachige Daten', () => {
  it('wählt die Sprache und fällt auf Englisch, dann Deutsch zurück', () => {
    expect(localized('Markt', 'sv')).toBe('Markt');
    expect(localized({ de: 'Markt', en: 'Market', sv: 'Marknad' }, 'sv')).toBe('Marknad');
    expect(localized({ de: 'Markt', en: 'Market' }, 'sv')).toBe('Market');
    expect(localized({ de: 'Markt' }, 'en')).toBe('Markt');
    expect(localizedUrl('https://warera.de/cases/?lang={lang}', 'en')).toBe('https://warera.de/cases/?lang=en');
  });

  const texts = (value: unknown) => allVariants(value as never);

  it('tools.json: jeder mehrsprachige Text hat eine deutsche Fassung', () => {
    const cats = JSON.parse(readFileSync('tools.json', 'utf8')) as { category: unknown; tools: Record<string, unknown>[] }[];
    for (const c of cats) {
      if (typeof c.category === 'object') expect((c.category as Record<string, string>).de, JSON.stringify(c.category)).toBeTruthy();
      for (const t of c.tools)
        for (const field of ['name', 'url', 'desc']) {
          const v = t[field];
          if (v && typeof v === 'object') expect((v as Record<string, string>).de, `${String(t.id)}.${field}`).toBeTruthy();
          for (const s of texts(v)) expect(s.trim(), `${String(t.id)}.${field}`).not.toBe('');
        }
    }
  });

  it('workspaces.json: jeder mehrsprachige Name hat eine deutsche Fassung', () => {
    const file = JSON.parse(readFileSync('workspaces.json', 'utf8')) as { presets: Record<string, unknown>[] };
    for (const p of file.presets)
      for (const field of ['name', 'desc']) {
        const v = p[field];
        if (v && typeof v === 'object') expect((v as Record<string, string>).de, `${String(p.id)}.${field}`).toBeTruthy();
      }
  });
});
