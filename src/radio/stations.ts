import { t } from '../i18n';

export type StationId = 'war-era-de' | 'warera-nachtwache' | 'warera-azura';

export interface Station {
  id: StationId;
  name: string;
  emoji: string;
  kind: 'laut' | 'azura';
  stream: string;
  /** Senderseite als Notlösung, falls der Direktstream streikt. */
  page: string;
  /** Jingle-Raster in Minuten, null = keine Jingles (Azura sendet sie live selbst). */
  jingleEvery: number | null;
}

export const AZURA_BASE = 'https://azuracast-production-9a4a.up.railway.app';

export const STATIONS: Station[] = [
  {
    id: 'war-era-de',
    // Name folgt der Sprache; Azura Live ist ein Eigenname
    get name() {
      return t('radio.station.main');
    },
    emoji: '🎵',
    kind: 'laut',
    stream: 'https://stream.laut.fm/war-era-de',
    page: 'https://laut.fm/war-era-de?autoplay=1',
    jingleEvery: 15,
  },
  {
    id: 'warera-nachtwache',
    get name() {
      return t('radio.station.night');
    },
    emoji: '🌙',
    kind: 'laut',
    stream: 'https://stream.laut.fm/warera-nachtwache',
    page: 'https://laut.fm/warera-nachtwache?autoplay=1',
    jingleEvery: 30,
  },
  {
    id: 'warera-azura',
    name: 'Azura Live',
    emoji: '📡',
    kind: 'azura',
    stream: `${AZURA_BASE}/listen/warera_radio/live`,
    page: `${AZURA_BASE}/public/warera_radio`,
    jingleEvery: null,
  },
];

export function getStation(id: string | null | undefined): Station | undefined {
  return STATIONS.find((s) => s.id === id);
}

export function isStationId(value: unknown): value is StationId {
  return typeof value === 'string' && STATIONS.some((s) => s.id === value);
}

/** Kurznamen für Links wie warera.de/r (Hauptradio), /n (Nachtwache) und /a (Azura). */
const ALIASES: Record<string, StationId> = {
  r: 'war-era-de',
  h: 'war-era-de',
  haupt: 'war-era-de',
  hauptradio: 'war-era-de',
  n: 'warera-nachtwache',
  nacht: 'warera-nachtwache',
  nachtwache: 'warera-nachtwache',
  a: 'warera-azura',
  azura: 'warera-azura',
  live: 'warera-azura',
};

export function stationFromAlias(value: string | null | undefined): StationId | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  if (isStationId(key)) return key;
  return ALIASES[key] ?? null;
}
