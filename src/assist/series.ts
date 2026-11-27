// Hilfen für Diagramme mit sehr vielen Punkten, ohne DOM, damit sie sich testen lassen.

/**
 * Wählt höchstens `max` Indizes aus 0 bis n−1, gleichmäßig verteilt und stets mit dem ersten und dem letzten Punkt.
 * Ein Verlauf mit 40.000 Ziehungen hat auf 600 Pixel Breite ohnehin nicht mehr Auflösung; die Linie bleibt dabei
 * gleich, weil Abstände zwischen den gewählten Punkten nur glatt überbrückt werden.
 */
export function sampleIndices(n: number, max: number): number[] {
  const count = Math.max(0, Math.floor(n));
  if (count <= max || max < 2) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = new Array(max);
  for (let k = 0; k < max; k++) out[k] = Math.round((k * (count - 1)) / (max - 1));
  return out;
}

/** Nimmt aus einer Reihe die gewählten Indizes; fehlt einer (kürzere Reihe), gilt der letzte Wert. */
export function pickIndices(values: readonly number[], indices: readonly number[]): number[] {
  if (indices.length === values.length && indices.every((v, i) => v === i)) return values.slice();
  const last = values.length - 1;
  return indices.map((i) => values[Math.min(i, last)]);
}
