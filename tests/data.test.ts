// Prüft die von Hand gepflegten Datendateien, damit ein Tippfehler den Deploy stoppt
// und nicht die Live-Seite leert.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeCategories, WIDGETS, type CategoryDef } from '../src/data/tools';
import { parseTimeKey } from '../src/core/clock';

const read = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

describe('tools.json', () => {
  const defs = read<CategoryDef[]>('tools.json');
  const cats = normalizeCategories(defs);

  it('enthält jedes Tool mit gültiger https-URL', () => {
    const raw = defs.flatMap((c) => c.tools);
    const normalized = cats.flatMap((c) => c.tools);
    expect(normalized.length).toBe(raw.length);
    for (const t of raw) expect(t.url.startsWith('https://'), t.name).toBe(true);
  });

  it('hat eindeutige IDs', () => {
    const ids = cats.flatMap((c) => c.tools.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('workspaces.json', () => {
  const file = read<{ defaults: string[]; presets: { id: string; layout: unknown }[] }>('workspaces.json');
  const known = new Set([...normalizeCategories(read<CategoryDef[]>('tools.json')).flatMap((c) => c.tools.map((t) => t.id)), ...WIDGETS.map((w) => w.id)]);

  const idsOf = (node: unknown): string[] => {
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.tabs)) return n.tabs as string[];
    const kids = (n.row ?? n.column) as unknown[];
    return kids.flatMap(idsOf);
  };

  it('verweist nur auf vorhandene Tools und Widgets', () => {
    for (const p of file.presets) {
      for (const id of idsOf(p.layout)) expect(known.has(id), `${p.id} → ${id}`).toBe(true);
    }
  });

  it('nennt nur existierende Vorlagen als Standard', () => {
    const presetIds = new Set(file.presets.map((p) => p.id));
    for (const d of file.defaults) expect(presetIds.has(d), d).toBe(true);
  });
});

describe('audio_schedule.json', () => {
  const schedule = read<{ jingles: Record<string, string>; inserts: { time: string; file: string; date?: string }[] }>('audio_schedule.json');

  it('hat gültige Uhrzeiten und Datumsangaben', () => {
    for (const i of schedule.inserts) {
      expect(Number.isNaN(parseTimeKey(i.time)), i.time).toBe(false);
      if (i.date) expect(i.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('verweist auf vorhandene Audiodateien', () => {
    const files = [...Object.values(schedule.jingles), ...schedule.inserts.map((i) => i.file)];
    for (const f of new Set(files)) expect(existsSync(f), f).toBe(true);
  });
});

describe('radio_schedule.json', () => {
  it('nutzt bekannte Sender und gültige Zeiten', () => {
    const file = read<{ schedule: { station: string; start: string; end: string }[] }>('radio_schedule.json');
    for (const e of file.schedule) {
      expect(['war-era-de', 'warera-nachtwache', 'warera-azura']).toContain(e.station);
      expect(Number.isNaN(parseTimeKey(e.start))).toBe(false);
      expect(Number.isNaN(parseTimeKey(e.end))).toBe(false);
    }
  });
});
