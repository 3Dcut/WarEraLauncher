// Reine Entscheidungslogik des Radios, ohne DOM und ohne Netzwerk, damit sie testbar bleibt.
// Die Regeln entsprechen der bisherigen Oberfläche; korrigiert sind die Statuserkennung
// ("inaktiv" enthält "aktiv", Icecast-Platzhalter-Mount) und die Zeitzone (Europe/Berlin).

import { parseTimeKey, minuteToTimeKey, type ClockParts } from '../core/clock';
import type { StationId } from './stations';

// ---------------------------------------------------------------- Status

export interface LautStatus {
  force: boolean;
  online: boolean;
}

export interface AzuraStatus {
  online: boolean;
  live: boolean;
}

export interface StatusSnapshot {
  main: LautStatus;
  nacht: LautStatus;
  azura: AzuraStatus;
}

export type StationLevel = 'force' | 'live' | 'online' | 'offline';

const AKTIV_WORD = /(^|[^a-zäöüß])aktiv/;

/** Wertet das Freitextfeld "format" einer laut.fm-Station aus (Claim-Protokoll der DJs). */
export function parseLautFormat(format: unknown): LautStatus {
  const fmt = typeof format === 'string' ? format.toLowerCase() : '';
  const force = fmt.includes('force');
  return { force, online: force || AKTIV_WORD.test(fmt) };
}

interface AzuraMount {
  name?: string;
  path?: string;
  bitrate?: number | null;
  format?: string | null;
  listeners?: { current?: number };
}

export interface AzuraNowPlaying {
  is_online?: boolean;
  live?: { is_live?: boolean; streamer_name?: string };
  station?: { mounts?: AzuraMount[] };
  now_playing?: { song?: { artist?: string; title?: string }; remaining?: number };
  listeners?: { current?: number; total?: number };
}

interface IcecastSource {
  listenurl?: string;
  stream_start?: string;
  connected?: number;
  title?: string;
  listeners?: number;
}

export interface IcecastStatus {
  icestats?: { source?: IcecastSource | IcecastSource[] };
}

export function icecastSources(data: IcecastStatus | null | undefined): IcecastSource[] {
  const src = data?.icestats?.source;
  if (!src) return [];
  return Array.isArray(src) ? src : [src];
}

/**
 * AzuraCast-API ist maßgeblich. Icecast dient nur als Rückfall, wenn die API nicht antwortet;
 * dort gilt der /live-Mount nur als verbunden, wenn stream_start oder connected gesetzt ist,
 * denn unverbunden steht er als Platzhalter ("dummy") in der Liste.
 */
export function parseAzura(nowPlaying: AzuraNowPlaying | null | undefined, icecast: IcecastStatus | null | undefined): AzuraStatus {
  if (nowPlaying) {
    const isLive = !!nowPlaying.live?.is_live;
    let online = !!nowPlaying.is_online || isLive;
    let live = isLive;
    if (nowPlaying.is_online) {
      const mount = nowPlaying.station?.mounts?.find((m) => m.name === '/live' || m.path === '/live');
      if (mount && (mount.bitrate != null || mount.format != null || (mount.listeners?.current ?? 0) > 0)) {
        live = true;
        online = true;
      }
    }
    return { online, live };
  }
  const liveSource = icecastSources(icecast).find((s) => /\/live$/.test(s.listenurl ?? '') && (s.stream_start || s.connected));
  return liveSource ? { online: true, live: true } : { online: false, live: false };
}

export function levelOf(status: StatusSnapshot | null, station: StationId): StationLevel {
  if (!status) return 'offline';
  if (station === 'warera-azura') return status.azura.live ? 'live' : status.azura.online ? 'online' : 'offline';
  const s = station === 'war-era-de' ? status.main : status.nacht;
  return s.force ? 'force' : s.online ? 'online' : 'offline';
}

// ---------------------------------------------------------------- Zeitplan

export interface RadioScheduleEntry {
  station: string;
  start: string;
  end: string;
}

export interface RadioSchedule {
  schedule?: RadioScheduleEntry[];
}

export function scheduledEntry(schedule: RadioSchedule | null | undefined, minuteOfDay: number): RadioScheduleEntry | null {
  for (const item of schedule?.schedule ?? []) {
    const start = parseTimeKey(item.start);
    const end = parseTimeKey(item.end);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const inWindow = start > end ? minuteOfDay >= start || minuteOfDay < end : minuteOfDay >= start && minuteOfDay < end;
    if (inWindow) return item;
  }
  return null;
}

// ---------------------------------------------------------------- Automatik

export interface AutoDecision {
  station: StationId | null;
  reason: string;
}

/**
 * Priorität wie bisher: Azura live > laut.fm FORCE > Azura online > laut.fm online > Zeitplan.
 * Sind beide laut.fm-Sender gleichrangig, bleibt der zuletzt gewählte Sender (sonst Hauptradio).
 */
export function pickStation(
  status: StatusSnapshot,
  lastStation: StationId | null,
  schedule: RadioSchedule | null,
  minuteOfDay: number,
): AutoDecision {
  const { main, nacht, azura } = status;
  const tie = (): StationId => lastStation ?? 'war-era-de';

  if (azura.live) return { station: 'warera-azura', reason: 'Azura: Live-DJ verbunden' };
  if (main.force && nacht.force) return { station: tie(), reason: 'Beide Sender auf FORCE' };
  if (main.force) return { station: 'war-era-de', reason: 'Hauptradio: FORCE' };
  if (nacht.force) return { station: 'warera-nachtwache', reason: 'Nachtwache: FORCE' };
  if (azura.online) return { station: 'warera-azura', reason: 'Azura: online' };
  if (main.online && nacht.online) return { station: tie(), reason: 'Beide Sender online' };
  if (nacht.online) return { station: 'warera-nachtwache', reason: 'Nachtwache: online' };
  if (main.online) return { station: 'war-era-de', reason: 'Hauptradio: online' };

  const entry = scheduledEntry(schedule, minuteOfDay);
  if (entry && isKnownStation(entry.station)) {
    return { station: entry.station, reason: `Zeitplan ${entry.start}–${entry.end}` };
  }
  return { station: null, reason: 'Kein Sender aktiv, kein Zeitplan' };
}

function isKnownStation(value: string): value is StationId {
  return value === 'war-era-de' || value === 'warera-nachtwache' || value === 'warera-azura';
}

// ---------------------------------------------------------------- Einspieler & Jingles

export interface Insert {
  date?: string;
  time: string;
  file: string;
  name?: string;
}

export interface AudioSchedule {
  jingles?: { none?: string; main?: string; main_alt?: string; nachtwache?: string };
  inserts?: Insert[];
}

export interface PlayableClip {
  id: string;
  file: string;
  name: string;
  jingle: boolean;
}

function insertsForDay(schedule: AudioSchedule | null, dateKey: string): Insert[] {
  return (schedule?.inserts ?? []).filter((i) => i && typeof i.time === 'string' && typeof i.file === 'string' && (!i.date || i.date === dateKey));
}

function sameMinute(a: string, b: string): boolean {
  return parseTimeKey(a) === parseTimeKey(b);
}

export function jingleInterval(station: StationId | null): number | null {
  if (station === 'warera-azura') return null;
  if (station === 'warera-nachtwache') return 30;
  return 15;
}

/** Welcher Jingle passt zum laufenden Sender und dessen Status? */
export function jingleFor(schedule: AudioSchedule | null, station: StationId | null, status: StatusSnapshot | null, minute: number): { file: string; name: string } | null {
  const j = schedule?.jingles;
  if (!j || !station || station === 'warera-azura') return null;
  if (station === 'war-era-de') {
    const online = !!status && (status.main.online || status.main.force);
    if (!online) return j.none ? { file: j.none, name: 'Jingle (Offline)' } : null;
    if (minute === 0 || minute === 30) return j.main_alt ? { file: j.main_alt, name: 'Nur das Beste auf die Ohren' } : null;
    return j.main ? { file: j.main, name: 'Jingle (Hauptradio)' } : null;
  }
  const online = !!status && (status.nacht.online || status.nacht.force);
  if (!online) return j.none ? { file: j.none, name: 'Jingle (Offline)' } : null;
  return j.nachtwache ? { file: j.nachtwache, name: 'Jingle (Nachtwache)' } : null;
}

/**
 * Was ist in dieser Minute fällig? Reguläre Einspieler haben Vorrang; ein Jingle entfällt,
 * wenn zur selben Minute ein Einspieler geplant ist (auch wenn dieser schon lief).
 */
export function dueClip(
  schedule: AudioSchedule | null,
  clock: ClockParts,
  station: StationId | null,
  status: StatusSnapshot | null,
  played: ReadonlySet<string>,
): PlayableClip | null {
  if (!schedule) return null;
  const today = insertsForDay(schedule, clock.dateKey);
  for (const insert of today) {
    const id = `${clock.dateKey}_${insert.time}_${insert.name ?? ''}`;
    if (sameMinute(insert.time, clock.timeKey) && !played.has(id)) {
      return { id, file: insert.file, name: insert.name ?? 'Einspieler', jingle: false };
    }
  }
  const every = jingleInterval(station);
  if (every && clock.minutes % every === 0 && !today.some((i) => sameMinute(i.time, clock.timeKey))) {
    const id = `${clock.dateKey}_jingle_${clock.timeKey}`;
    if (!played.has(id)) {
      const jingle = jingleFor(schedule, station, status, clock.minutes);
      if (jingle) return { id, file: jingle.file, name: jingle.name, jingle: true };
    }
  }
  return null;
}

export interface UpcomingClip {
  time: string;
  name: string;
  jingle: boolean;
}

/** Vorschau der nächsten Einspieler und Jingles des heutigen Tages. */
export function upcomingClips(
  schedule: AudioSchedule | null,
  clock: ClockParts,
  station: StationId | null,
  status: StatusSnapshot | null,
  count: number,
): UpcomingClip[] {
  if (!schedule) return [];
  const list: (UpcomingClip & { minute: number })[] = [];
  const occupied = new Set<number>();
  for (const insert of insertsForDay(schedule, clock.dateKey)) {
    const minute = parseTimeKey(insert.time);
    if (Number.isNaN(minute) || minute <= clock.minuteOfDay) continue;
    list.push({ time: minuteToTimeKey(minute), name: insert.name ?? 'Einspieler', jingle: false, minute });
    occupied.add(minute);
  }
  const every = jingleInterval(station);
  if (every && station) {
    for (let m = clock.minuteOfDay + 1; m < 24 * 60; m++) {
      if (m % every !== 0 || occupied.has(m)) continue;
      const jingle = jingleFor(schedule, station, status, m % 60);
      if (jingle) list.push({ time: minuteToTimeKey(m), name: jingle.name, jingle: true, minute: m });
    }
  }
  return list.sort((a, b) => a.minute - b.minute).slice(0, count);
}
