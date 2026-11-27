import type { Rarity } from './logic';

/** Farben der Seltenheiten wie im Spiel (Kennung, keine Wertung). */
export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#a7b0c0',
  uncommon: '#4ade80',
  rare: '#60a5fa',
  epic: '#c084fc',
  legendary: '#fbbf24',
  mythic: '#f43f5e',
};
