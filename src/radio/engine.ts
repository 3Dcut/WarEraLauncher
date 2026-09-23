// Laufzeit des Radios: ein dauerhaftes <audio>-Element für den Stream, ein zweites für Einspieler.
// Zustand liegt in Signals, damit Pille, Widget und Mini-Player dieselbe Quelle nutzen.

import { signal, computed } from '@preact/signals';
import { berlinParts, parseLautTime } from '../core/clock';
import { fetchJson, fetchLocalJson, fetchText } from '../core/http';
import { load, save, loadLegacy } from '../core/storage';
import { settings, toast } from '../state';
import { STATIONS, AZURA_BASE, getStation, isStationId, type StationId } from './stations';
import {
  parseLautFormat,
  parseAzura,
  pickStation,
  dueClip,
  levelOf,
  upcomingClips,
  type StatusSnapshot,
  type AudioSchedule,
  type RadioSchedule,
  type AzuraNowPlaying,
  type IcecastStatus,
  type PlayableClip,
  icecastSources,
} from './logic';

export type RadioPhase = 'idle' | 'connecting' | 'playing' | 'paused' | 'blocked' | 'reconnecting';

export interface NowPlaying {
  title: string;
  listeners: string | null;
}

interface RadioPrefs {
  volume: number;
  auto: boolean;
  lastStation: StationId | null;
}

function initialPrefs(): RadioPrefs {
  const stored = load<Partial<RadioPrefs> | null>('radio', null);
  if (stored) {
    return {
      volume: typeof stored.volume === 'number' ? stored.volume : 0.65,
      auto: !!stored.auto,
      lastStation: isStationId(stored.lastStation) ? stored.lastStation : null,
    };
  }
  const legacyLast = loadLegacy('wl-last-station');
  return { volume: 0.65, auto: loadLegacy('wl-auto-radio') === 'true', lastStation: isStationId(legacyLast) ? legacyLast : null };
}

const prefs = initialPrefs();

// ------------------------------------------------------------------ öffentlicher Zustand

export const station = signal<StationId | null>(prefs.lastStation);
export const phase = signal<RadioPhase>('idle');
export const autoMode = signal<boolean>(prefs.auto);
export const autoReason = signal<string>('');
export const volume = signal<number>(prefs.volume);
export const status = signal<StatusSnapshot | null>(null);
export const nowPlaying = signal<NowPlaying | null>(null);
export const activeClip = signal<string | null>(null);
export const waitingClip = signal<string | null>(null);
export const audioSchedule = signal<AudioSchedule | null>(null);
export const radioSchedule = signal<RadioSchedule | null>(null);
export const otherTabPlaying = signal(false);

export const isPlaying = computed(() => phase.value === 'playing' || phase.value === 'connecting' || phase.value === 'reconnecting');

export const upcoming = computed(() => {
  // Zeitabhängig; die Anzeige ruft das bei jedem Öffnen bzw. Minutentakt neu ab
  void tick.value;
  return upcomingClips(audioSchedule.value, berlinParts(), station.value, status.value, 4);
});

/** Minütlicher Takt, damit zeitabhängige Ableitungen neu rechnen. */
export const tick = signal(0);

function persist(): void {
  save('radio', { volume: volume.value, auto: autoMode.value, lastStation: station.value } satisfies RadioPrefs);
}

// ------------------------------------------------------------------ Audio-Elemente

let stream: HTMLAudioElement;
let insertAudio: HTMLAudioElement;
let volumeControllable = true;

let wantPlaying = false; // Absicht des Nutzers (bzw. der Automatik), dass Musik läuft
let abortClip: (() => void) | null = null;
let reconnectTimer: number | undefined;
let connectTimer: number | undefined;
let reconnectAttempt = 0;
let infoTimer: number | undefined;
let pendingClipTimer: number | undefined;
let clipPlaying = false;
const played = new Set<string>();
let playedDay = berlinParts().dateKey;
let lastPosition = -1;
let frozenCycles = 0;

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('warera-radio') : null;
const tabId = Math.random().toString(36).slice(2);

function createAudio(id: string): HTMLAudioElement {
  const el = document.createElement('audio');
  el.id = id;
  el.preload = 'none';
  // Kein crossOrigin: der 302-Redirect von stream.laut.fm liefert keinen CORS-Header
  document.body.appendChild(el);
  return el;
}

function detectVolumeControl(): boolean {
  // iOS ignoriert HTMLMediaElement.volume; dann wird über "muted" geduckt
  const probe = document.createElement('audio');
  try {
    probe.volume = 0.5;
    return probe.volume === 0.5;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ Wiedergabe

export function play(id: StationId, opts: { user: boolean }): void {
  const target = getStation(id);
  if (!target) return;
  if (opts.user && autoMode.value) setAuto(false, true);

  const same = station.value === id && !stream.paused && stream.src;
  station.value = id;
  persist();
  wantPlaying = true;
  if (same) return;

  cancelPendingClip();
  abortClip?.();
  clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  nowPlaying.value = null;
  startStream();
  startInfoPolling();
  channel?.postMessage({ type: 'playing', tabId });
  otherTabPlaying.value = false;
}

function startStream(): void {
  const target = getStation(station.value);
  if (!target) return;
  phase.value = phase.value === 'reconnecting' ? 'reconnecting' : 'connecting';
  // Verbindungsaufbau (Redirect, langsames Netz) darf dauern; erst ohne Ton nach 15 s neu versuchen
  clearTimeout(connectTimer);
  connectTimer = window.setTimeout(() => {
    if (wantPlaying && (phase.value === 'connecting' || phase.value === 'reconnecting')) scheduleReconnect('Keine Verbindung');
  }, 15_000);
  stream.src = `${target.stream}?t=${Date.now()}`;
  applyVolume();
  stream.load();
  stream
    .play()
    .then(() => {
      if (wantPlaying) phase.value = 'playing';
    })
    .catch((err: DOMException) => {
      if (err?.name === 'NotAllowedError') {
        // Browser verlangt eine Nutzeraktion; beim nächsten Klick irgendwo starten wir
        phase.value = 'blocked';
        armGestureStart();
      } else if (err?.name !== 'AbortError') {
        scheduleReconnect('Start fehlgeschlagen');
      }
    });
}

export function pause(opts: { user: boolean }): void {
  wantPlaying = false;
  cancelPendingClip();
  clearTimeout(reconnectTimer);
  clearTimeout(connectTimer);
  stopInfoPolling();
  abortClip?.();
  stream.pause();
  stream.removeAttribute('src');
  stream.load();
  phase.value = opts.user ? 'paused' : 'idle';
  updateMediaSession();
}

export function toggle(): void {
  if (phase.value === 'blocked') {
    // Klick ist die vom Browser verlangte Nutzeraktion
    startStream();
    return;
  }
  if (isPlaying.value) {
    pause({ user: true });
    return;
  }
  if (autoMode.value && status.value) {
    const decision = decide();
    if (decision.station) {
      play(decision.station, { user: false });
      return;
    }
  }
  play(station.value ?? 'war-era-de', { user: false });
}

export function setVolume(value: number): void {
  volume.value = Math.min(1, Math.max(0, value));
  if (!clipPlaying) applyVolume();
  else insertAudio.volume = volume.value;
  persist();
}

function applyVolume(): void {
  if (volumeControllable) stream.volume = volume.value;
  stream.muted = false;
}

export function setAuto(on: boolean, silent = false): void {
  autoMode.value = on;
  persist();
  if (on) {
    void pollStatus().then(() => {
      if (!autoMode.value || !status.value) return;
      const decision = decide();
      if (decision.station) play(decision.station, { user: false });
    });
  } else if (!silent) {
    autoReason.value = '';
  }
}

function decide() {
  const decision = pickStation(status.value!, station.value, radioSchedule.value, berlinParts().minuteOfDay);
  autoReason.value = decision.reason;
  return decision;
}

let gestureArmed = false;
function armGestureStart(): void {
  if (gestureArmed) return;
  gestureArmed = true;
  const resume = (e: Event) => {
    // Radio-Bedienelemente starten selbst (toggle), sonst gäbe es Doppelstarts
    if ((e.target as Element | null)?.closest?.('[data-radio-control]')) return;
    gestureArmed = false;
    window.removeEventListener('click', resume, true);
    window.removeEventListener('keydown', resume, true);
    if (phase.value === 'blocked' && wantPlaying) startStream();
  };
  window.addEventListener('click', resume, true);
  window.addEventListener('keydown', resume, true);
}

// ------------------------------------------------------------------ Wiederverbindung & Wachhund

function scheduleReconnect(reason: string): void {
  if (!wantPlaying || clipPlaying) return;
  if (phase.value === 'blocked') return;
  clearTimeout(reconnectTimer);
  const delays = [150, 1500, 3000, 6000, 12000, 30000];
  const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
  reconnectAttempt++;
  phase.value = 'reconnecting';
  console.warn(`[Radio] Neuverbindung in ${delay} ms (${reason})`);
  reconnectTimer = window.setTimeout(() => {
    if (wantPlaying && !clipPlaying) startStream();
  }, delay);
}

function watchdog(): void {
  if (!wantPlaying || clipPlaying || phase.value === 'reconnecting' || phase.value === 'blocked' || phase.value === 'connecting') return;
  if (stream.error || stream.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
    scheduleReconnect('Fehlerstatus');
    return;
  }
  if (!stream.paused && stream.readyState >= 2) {
    if (stream.currentTime === lastPosition && stream.currentTime > 0) {
      frozenCycles++;
      if (frozenCycles >= 2) {
        frozenCycles = 0;
        scheduleReconnect('Wiedergabe eingefroren');
      }
    } else {
      frozenCycles = 0;
      lastPosition = stream.currentTime;
    }
  }
}

function wireStreamEvents(): void {
  stream.addEventListener('playing', () => {
    clearTimeout(connectTimer);
    if (!wantPlaying) return;
    phase.value = 'playing';
    reconnectAttempt = 0;
    updateMediaSession();
  });
  stream.addEventListener('error', () => {
    if (stream.getAttribute('src')) scheduleReconnect('Stream-Fehler');
  });
  stream.addEventListener('ended', () => scheduleReconnect('Stream beendet (DJ-/Quellwechsel)'));
  stream.addEventListener('stalled', () => {
    // Nur bei laufender Wiedergabe; während des Verbindungsaufbaus wacht connectTimer
    if (phase.value !== 'playing') return;
    window.setTimeout(() => {
      if (wantPlaying && !clipPlaying && phase.value === 'playing' && (stream.readyState < 3 || stream.paused)) scheduleReconnect('Puffer leer');
    }, 1000);
  });
  stream.addEventListener('pause', () => {
    // Pause von außen (Medientaste, Kopfhörer abgezogen, Betriebssystem) = Wunsch des Nutzers
    if (!wantPlaying || clipPlaying) return;
    if (stream.error || stream.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) return;
    if (phase.value === 'reconnecting' || phase.value === 'connecting') return;
    wantPlaying = false;
    stopInfoPolling();
    cancelPendingClip();
    phase.value = 'paused';
    updateMediaSession();
  });
  window.addEventListener('online', () => {
    if (wantPlaying) scheduleReconnect('Netzwerk wieder online');
  });
}

// ------------------------------------------------------------------ Status & Titelinfo

let previousLevels: Record<string, string> = {};

export async function pollStatus(): Promise<void> {
  const t = Date.now();
  const [main, nacht, azura, ice] = await Promise.all([
    fetchJson<{ format?: string }>(`https://api.laut.fm/station/war-era-de?t=${t}`).catch(() => null),
    fetchJson<{ format?: string }>(`https://api.laut.fm/station/warera-nachtwache?t=${t}`).catch(() => null),
    fetchJson<AzuraNowPlaying>(`${AZURA_BASE}/api/nowplaying/warera_radio?t=${t}`).catch(() => null),
    fetchJson<IcecastStatus>(`${AZURA_BASE}/radio/8000/status-json.xsl?t=${t}`).catch(() => null),
  ]);
  if (!main && !nacht && !azura && !ice) return; // offline: letzten Stand behalten

  const snapshot: StatusSnapshot = {
    main: parseLautFormat(main?.format),
    nacht: parseLautFormat(nacht?.format),
    azura: parseAzura(azura, ice),
  };
  status.value = snapshot;
  announceLiveChanges(snapshot);

  if (autoMode.value) {
    const decision = decide();
    const shouldSwitch = decision.station && (isPlaying.value || phase.value === 'blocked') && decision.station !== station.value;
    if (shouldSwitch) play(decision.station!, { user: false });
  }
}

function announceLiveChanges(snapshot: StatusSnapshot): void {
  const next: Record<string, string> = {};
  for (const s of STATIONS) next[s.id] = levelOf(snapshot, s.id);
  const first = Object.keys(previousLevels).length === 0;
  if (!first) {
    for (const s of STATIONS) {
      const before = previousLevels[s.id];
      const now = next[s.id];
      const becameHot = (now === 'live' || now === 'force') && before !== 'live' && before !== 'force';
      if (!becameHot) continue;
      const msg = `${s.name} ist jetzt ${now === 'force' ? 'auf FORCE' : 'LIVE'}`;
      toast(msg, 'live', station.value === s.id && isPlaying.value ? undefined : { label: 'Einschalten', run: () => play(s.id, { user: true }) }, 9000);
      notify(msg);
    }
  }
  previousLevels = next;
}

function notify(message: string): void {
  if (!settings.value.notifyLive || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted' || !document.hidden) return;
  try {
    new Notification('WarEra Radio', { body: message, icon: './icon.svg', tag: 'warera-radio-live' });
  } catch {
    /* manche Browser erlauben Notification nur im Service Worker */
  }
}

async function fetchNowPlaying(): Promise<void> {
  const id = station.value;
  if (!id || !wantPlaying || clipPlaying) return;
  try {
    if (id === 'warera-azura') {
      const data = await fetchJson<AzuraNowPlaying>(`${AZURA_BASE}/api/nowplaying/warera_radio?t=${Date.now()}`).catch(() => null);
      let title = 'AzuraCast Live-Stream';
      let listeners: string | null = null;
      if (data) {
        const song = data.now_playing?.song;
        if (song && (song.artist || song.title) && song.title !== 'Station Offline') {
          title = song.artist ? `${song.artist} – ${song.title}` : song.title ?? title;
        }
        listeners = String(data.listeners?.current ?? data.listeners?.total ?? 0);
      } else {
        const ice = await fetchJson<IcecastStatus>(`${AZURA_BASE}/radio/8000/status-json.xsl?t=${Date.now()}`).catch(() => null);
        const live = icecastSources(ice).find((s) => /\/live$/.test(s.listenurl ?? '') && s.stream_start);
        if (live?.title) title = live.title;
        if (live?.listeners != null) listeners = String(live.listeners);
      }
      if (station.value === id) nowPlaying.value = { title, listeners };
    } else {
      const [song, list] = await Promise.all([
        fetchJson<{ title?: string; artist?: { name?: string } }>(`https://api.laut.fm/station/${id}/current_song`),
        fetchText(`https://api.laut.fm/station/${id}/listeners`).catch(() => ''),
      ]);
      const artist = song.artist?.name;
      const title = artist ? `${artist} – ${song.title ?? ''}` : song.title ?? '';
      if (station.value === id) nowPlaying.value = { title, listeners: list.trim() || null };
    }
    updateMediaSession();
  } catch (err) {
    console.warn('[Radio] Titelinfo nicht verfügbar', err);
  }
}

function startInfoPolling(): void {
  stopInfoPolling();
  void fetchNowPlaying();
  infoTimer = window.setInterval(fetchNowPlaying, 15_000);
}

function stopInfoPolling(): void {
  clearInterval(infoTimer);
  infoTimer = undefined;
}

// ------------------------------------------------------------------ Einspieler

async function msUntilSongEnd(id: StationId): Promise<number> {
  if (getStation(id)?.kind !== 'laut') return 0;
  try {
    const song = await fetchJson<{ ends_at?: string }>(`https://api.laut.fm/station/${id}/current_song?t=${Date.now()}`);
    const end = parseLautTime(song.ends_at);
    return end ? Math.max(0, end.getTime() - Date.now()) : 0;
  } catch {
    return 0;
  }
}

function cancelPendingClip(): void {
  clearTimeout(pendingClipTimer);
  pendingClipTimer = undefined;
  waitingClip.value = null;
}

async function scheduleClip(clip: PlayableClip): Promise<void> {
  const id = station.value;
  if (!id || !wantPlaying) return;
  const ms = await msUntilSongEnd(id);
  if (!wantPlaying || station.value !== id) return;
  if (ms <= 2000) {
    void playClip(clip, id);
    return;
  }
  waitingClip.value = clip.name;
  pendingClipTimer = window.setTimeout(() => {
    pendingClipTimer = undefined;
    waitingClip.value = null;
    if (wantPlaying && station.value === id) void playClip(clip, id);
  }, ms + 2000);
}

function fade(el: HTMLAudioElement, from: number, to: number, duration: number): Promise<void> {
  return new Promise((resolve) => {
    if (!volumeControllable) {
      resolve();
      return;
    }
    const steps = 20;
    let step = 0;
    const timer = window.setInterval(() => {
      step++;
      el.volume = Math.min(1, Math.max(0, from + ((to - from) * step) / steps));
      if (step >= steps) {
        clearInterval(timer);
        resolve();
      }
    }, duration / steps);
  });
}

async function playClip(clip: PlayableClip, id: StationId): Promise<void> {
  if (clipPlaying) return;
  clipPlaying = true;
  activeClip.value = clip.name;
  const level = volume.value;
  try {
    if (volumeControllable) await fade(stream, level, 0, 500);
    else stream.muted = true;

    insertAudio.src = `${clip.file}?t=${Date.now()}`;
    insertAudio.volume = level;
    await new Promise<void>((resolve) => {
      let limit = window.setTimeout(resolve, 10 * 60_000); // Sicherheitsnetz: nie dauerhaft stumm
      const done = () => {
        clearTimeout(limit);
        abortClip = null;
        resolve();
      };
      abortClip = done;
      insertAudio.addEventListener('ended', done, { once: true });
      insertAudio.addEventListener('error', done, { once: true });
      insertAudio.addEventListener(
        'loadedmetadata',
        () => {
          if (Number.isFinite(insertAudio.duration)) {
            clearTimeout(limit);
            limit = window.setTimeout(resolve, insertAudio.duration * 1000 + 15_000);
          }
        },
        { once: true },
      );
      insertAudio.play().catch(done);
    });
  } catch (err) {
    console.error('[Radio] Einspieler-Fehler', err);
  } finally {
    insertAudio.pause();
    insertAudio.removeAttribute('src');
    clipPlaying = false;
    activeClip.value = null;
    if (wantPlaying && station.value === id) {
      if (stream.paused) await stream.play().catch(() => undefined);
      stream.muted = false;
      if (volumeControllable) await fade(stream, 0, volume.value, 500);
      void fetchNowPlaying();
    } else {
      stream.muted = false;
      applyVolume();
    }
  }
}

function checkClips(): void {
  const clock = berlinParts();
  if (clock.dateKey !== playedDay) {
    played.clear();
    playedDay = clock.dateKey;
  }
  if (!wantPlaying || phase.value !== 'playing' || clipPlaying || pendingClipTimer) return;
  const clip = dueClip(audioSchedule.value, clock, station.value, status.value, played);
  if (!clip) return;
  played.add(clip.id);
  void scheduleClip(clip);
}

async function loadSchedules(): Promise<void> {
  const [audio, radio] = await Promise.all([
    fetchLocalJson<AudioSchedule>('./audio_schedule.json').catch(() => null),
    fetchLocalJson<RadioSchedule>('./radio_schedule.json').catch(() => null),
  ]);
  if (audio) audioSchedule.value = audio;
  if (radio) radioSchedule.value = radio;
}

// ------------------------------------------------------------------ Media Session

function updateMediaSession(): void {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const s = getStation(station.value);
  try {
    ms.playbackState = isPlaying.value ? 'playing' : phase.value === 'paused' ? 'paused' : 'none';
    if (s) {
      ms.metadata = new MediaMetadata({
        title: activeClip.value ? `Einspieler: ${activeClip.value}` : nowPlaying.value?.title || s.name,
        artist: `WarEra Radio · ${s.name}`,
        album: 'WarEra Launcher',
        artwork: [{ src: new URL('./icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' }],
      });
    }
  } catch {
    /* ältere Browser */
  }
}

function wireMediaSession(): void {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      /* Aktion nicht unterstützt */
    }
  };
  set('play', () => toggleIfPaused());
  set('pause', () => pause({ user: true }));
  set('stop', () => pause({ user: true }));
  set('nexttrack', () => cycleStation(1));
  set('previoustrack', () => cycleStation(-1));
}

function toggleIfPaused(): void {
  if (!isPlaying.value) toggle();
}

export function cycleStation(dir: 1 | -1): void {
  const idx = STATIONS.findIndex((s) => s.id === station.value);
  const next = STATIONS[(idx + dir + STATIONS.length) % STATIONS.length];
  play(next.id, { user: true });
}

// ------------------------------------------------------------------ Start

let started = false;

export function initRadio(): void {
  if (started) return;
  started = true;
  stream = createAudio('radio-stream');
  insertAudio = createAudio('radio-insert');
  insertAudio.preload = 'auto';
  volumeControllable = detectVolumeControl();
  wireStreamEvents();
  wireMediaSession();

  channel?.addEventListener('message', (e: MessageEvent<{ type: string; tabId: string }>) => {
    if (e.data?.type === 'playing' && e.data.tabId !== tabId && (isPlaying.value || phase.value === 'blocked')) {
      pause({ user: false });
      otherTabPlaying.value = true;
      toast('Das Radio läuft jetzt in einem anderen Fenster.', 'info');
    }
  });

  void loadSchedules().then(() => pollStatus()).then(() => {
    if (autoMode.value && status.value) {
      const decision = decide();
      if (decision.station) play(decision.station, { user: false });
    }
  });

  window.setInterval(() => void pollStatus(), 60_000);
  window.setInterval(() => void loadSchedules(), 60_000);
  window.setInterval(checkClips, 15_000);
  window.setInterval(watchdog, 2_000);
  window.setInterval(() => (tick.value = tick.value + 1), 30_000);
}
