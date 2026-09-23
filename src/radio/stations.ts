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
    name: 'Hauptradio',
    emoji: '🎵',
    kind: 'laut',
    stream: 'https://stream.laut.fm/war-era-de',
    page: 'https://laut.fm/war-era-de?autoplay=1',
    jingleEvery: 15,
  },
  {
    id: 'warera-nachtwache',
    name: 'Nachtwache',
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
