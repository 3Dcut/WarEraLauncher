import { describe, it, expect } from 'vitest';
import {
  parseLautFormat,
  parseAzura,
  pickStation,
  scheduledEntry,
  dueClip,
  upcomingClips,
  jingleFor,
  type StatusSnapshot,
  type AudioSchedule,
} from '../src/radio/logic';
import { berlinParts, parseLautTime } from '../src/core/clock';

const OFF = { force: false, online: false };
const status = (patch: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  main: OFF,
  nacht: OFF,
  azura: { online: false, live: false },
  ...patch,
});
const radioSchedule = {
  schedule: [
    { station: 'warera-nachtwache', start: '21:00', end: '06:00' },
    { station: 'war-era-de', start: '06:00', end: '21:00' },
  ],
};

describe('parseLautFormat', () => {
  it('wertet "inaktiv." als offline (Regression)', () => {
    expect(parseLautFormat('inaktiv.')).toEqual({ force: false, online: false });
  });
  it('erkennt aktiv und force', () => {
    expect(parseLautFormat('aktiv')).toEqual({ force: false, online: true });
    expect(parseLautFormat('Aktiv - DJ Hirsch')).toEqual({ force: false, online: true });
    expect(parseLautFormat('FORCE')).toEqual({ force: true, online: true });
    expect(parseLautFormat('')).toEqual({ force: false, online: false });
    expect(parseLautFormat(undefined)).toEqual({ force: false, online: false });
  });
});

describe('parseAzura', () => {
  it('ignoriert den unverbundenen Icecast-Platzhalter (Regression)', () => {
    const icecast = {
      icestats: {
        source: [
          { listeners: 0, listenurl: 'http://x:8000/live', dummy: null },
          { listenurl: 'https://x/listen/warera_radio/radio.mp3', stream_start: 'x', title: 'AzuraCast is Live!' },
        ],
      },
    };
    const api = { is_online: false, live: { is_live: false }, station: { mounts: [{ name: '/live', bitrate: null, format: null }] } };
    expect(parseAzura(api, icecast)).toEqual({ online: false, live: false });
    expect(parseAzura(null, icecast)).toEqual({ online: false, live: false });
  });
  it('erkennt Live-DJ über die API und verbundenen Mount als Rückfall', () => {
    expect(parseAzura({ is_online: true, live: { is_live: true } }, null)).toEqual({ online: true, live: true });
    expect(parseAzura({ is_online: true, live: { is_live: false } }, null)).toEqual({ online: true, live: false });
    const icecast = { icestats: { source: { listenurl: 'http://x:8000/live', stream_start: 'now' } } };
    expect(parseAzura(null, icecast)).toEqual({ online: true, live: true });
  });
});

describe('pickStation', () => {
  it('folgt der Priorität Azura live > FORCE > Azura online > online > Zeitplan', () => {
    expect(pickStation(status({ azura: { online: true, live: true }, main: { force: true, online: true } }), null, radioSchedule, 600).station).toBe('warera-azura');
    expect(pickStation(status({ nacht: { force: true, online: true }, azura: { online: true, live: false } }), null, radioSchedule, 600).station).toBe('warera-nachtwache');
    expect(pickStation(status({ azura: { online: true, live: false }, main: { force: false, online: true } }), null, radioSchedule, 600).station).toBe('warera-azura');
    expect(pickStation(status({ nacht: { force: false, online: true } }), null, radioSchedule, 600).station).toBe('warera-nachtwache');
  });
  it('bleibt bei Gleichstand beim letzten Sender', () => {
    const both = status({ main: { force: true, online: true }, nacht: { force: true, online: true } });
    expect(pickStation(both, 'warera-nachtwache', radioSchedule, 600).station).toBe('warera-nachtwache');
    expect(pickStation(both, null, radioSchedule, 600).station).toBe('war-era-de');
  });
  it('fällt auf den Zeitplan zurück, auch über Mitternacht', () => {
    expect(pickStation(status(), null, radioSchedule, 22 * 60).station).toBe('warera-nachtwache');
    expect(pickStation(status(), null, radioSchedule, 3 * 60).station).toBe('warera-nachtwache');
    expect(pickStation(status(), null, radioSchedule, 6 * 60).station).toBe('war-era-de');
    expect(scheduledEntry({ schedule: [] }, 100)).toBeNull();
  });
});

describe('Einspieler und Jingles', () => {
  const schedule: AudioSchedule = {
    jingles: { none: 'off.mp3', main: 'main.mp3', main_alt: 'alt.mp3', nachtwache: 'nw.mp3' },
    inserts: [
      { date: '2026-09-23', time: '12:00', file: 'a.mp3', name: 'Mittag' },
      { time: '18:15', file: 'b.mp3', name: 'Täglich' },
      { date: '2026-09-24', time: '12:00', file: 'c.mp3', name: 'Morgen' },
    ],
  };
  const at = (iso: string) => berlinParts(new Date(iso));
  const online = status({ main: { force: false, online: true }, nacht: { force: false, online: true } });

  it('spielt den datierten Einspieler nur am richtigen Tag', () => {
    const clip = dueClip(schedule, at('2026-09-23T10:00:00Z'), 'war-era-de', online, new Set());
    expect(clip?.file).toBe('a.mp3');
    expect(dueClip(schedule, at('2026-09-23T10:00:00Z'), 'war-era-de', online, new Set([clip!.id]))).toBeNull();
  });
  it('unterdrückt den Jingle, wenn ein Einspieler dieselbe Minute belegt', () => {
    const played = new Set(['2026-09-23_18:15_Täglich']);
    expect(dueClip(schedule, at('2026-09-23T16:15:00Z'), 'war-era-de', online, played)).toBeNull();
  });
  it('wählt Jingles nach Sender und Status', () => {
    expect(dueClip(schedule, at('2026-09-23T08:45:00Z'), 'war-era-de', online, new Set())?.file).toBe('main.mp3');
    expect(dueClip(schedule, at('2026-09-23T08:30:00Z'), 'war-era-de', online, new Set())?.file).toBe('alt.mp3');
    expect(dueClip(schedule, at('2026-09-23T08:45:00Z'), 'warera-nachtwache', online, new Set())).toBeNull();
    expect(dueClip(schedule, at('2026-09-23T08:30:00Z'), 'warera-nachtwache', status(), new Set())?.file).toBe('off.mp3');
    expect(dueClip(schedule, at('2026-09-23T08:30:00Z'), 'warera-azura', online, new Set())).toBeNull();
    expect(jingleFor(schedule, null, online, 15)).toBeNull();
  });
  it('rechnet in deutscher Zeit', () => {
    expect(at('2026-09-23T22:30:00Z').timeKey).toBe('00:30');
    expect(at('2026-09-23T22:30:00Z').dateKey).toBe('2026-09-24');
  });
  it('liefert eine sortierte Vorschau', () => {
    const list = upcomingClips(schedule, at('2026-09-23T09:50:00Z'), 'war-era-de', online, 3);
    expect(list.map((c) => c.time)).toEqual(['12:00', '12:15', '12:30']);
    expect(list[0].jingle).toBe(false);
  });
});

describe('parseLautTime', () => {
  it('versteht das laut.fm-Format', () => {
    expect(parseLautTime('2026-04-06 16:56:53 +0200')?.toISOString()).toBe('2026-04-06T14:56:53.000Z');
    expect(parseLautTime('')).toBeNull();
  });
});
