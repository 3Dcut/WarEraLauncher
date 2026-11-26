// Welche Tools angeboten werden: ausgeblendet, Build-Check und Prüfung im Browser zusammen.
import { describe, it, expect } from 'vitest';
import { normalizeCategories, unavailableReason, GAME_TOOL, WIDGETS, type Tool, type ToolHealth } from '../src/data/tools';
import { mergeProbeResults, isStale, type ProbeResult } from '../src/data/reachability';

const tool = (health: ToolHealth = 'ok', extra: Partial<Tool> = {}): Tool => ({
  ...normalizeCategories([{ category: 'Test', tools: [{ id: 'x', name: 'X', url: 'https://example.org' }] }])[0].tools[0],
  health,
  ...extra,
});

describe('unavailableReason', () => {
  it('bietet gesunde Tools, Widgets und das Spiel an', () => {
    expect(unavailableReason(tool('ok'), {})).toBeNull();
    expect(unavailableReason(tool('unknown'), {})).toBeNull();
    expect(unavailableReason(WIDGETS[0], {})).toBeNull();
    expect(unavailableReason(GAME_TOOL, { 'warera-game': { ok: false, at: 1 } })).toBeNull();
  });

  it('blendet ausgeblendete und tote Tools immer aus', () => {
    expect(unavailableReason(tool('ok', { hidden: true, note: 'veraltet' }), { x: { ok: true, at: 1 } })).toContain('veraltet');
    expect(unavailableReason(tool('dead'), { x: { ok: true, at: 1 } })).not.toBeNull();
  });

  it('lässt die Prüfung im Browser über Erreichbarkeit entscheiden', () => {
    expect(unavailableReason(tool('ok'), { x: { ok: false, at: 1 } })).not.toBeNull();
    expect(unavailableReason(tool('down'), { x: { ok: true, at: 1 } })).toBeNull();
    expect(unavailableReason(tool('down'), {})).not.toBeNull();
  });

  it('lässt sich bei Serverfehlern aus dem Build-Check nicht von der Browser-Prüfung umstimmen', () => {
    // no-cors sieht keinen Statuscode, eine 503-Fehlerseite gälte sonst als erreichbar
    expect(unavailableReason(tool('down', { healthCode: 503 }), { x: { ok: true, at: 1 } })).toContain('503');
  });
});

describe('mergeProbeResults', () => {
  const ok: ProbeResult = { ok: true, at: 2 };
  const fail: ProbeResult = { ok: false, at: 2 };

  it('übernimmt einzelne Ausfälle', () => {
    expect(mergeProbeResults({ a: ok }, [['b', fail]])).toEqual({ a: ok, b: fail });
  });

  it('verwirft eine Runde, in der alles scheitert (eigenes Netz oder Blocker)', () => {
    expect(mergeProbeResults({ a: ok }, [['a', fail], ['b', fail], ['c', fail]])).toBeNull();
    expect(mergeProbeResults({}, [])).toBeNull();
  });
});

describe('isStale', () => {
  it('prüft nicht erreichbare Seiten öfter als erreichbare', () => {
    const now = 100 * 60_000;
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale({ ok: true, at: now - 10 * 60_000 }, now)).toBe(false);
    expect(isStale({ ok: false, at: now - 10 * 60_000 }, now)).toBe(true);
  });
});
