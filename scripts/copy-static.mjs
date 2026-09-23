// Kopiert Daten-, Audio- und Zusatzdateien unverändert nach dist/, damit sie zur Laufzeit
// geladen und weiterhin ohne Code-Änderung gepflegt werden können.
import { cpSync, existsSync } from 'node:fs';

const entries = [
  'tools.json',
  'workspaces.json',
  'audio_schedule.json',
  'radio_schedule.json',
  'legacy.html',
  'CNAME',
  'audio',
  'wahl',
];

for (const entry of entries) {
  if (!existsSync(entry)) {
    console.warn(`übersprungen (fehlt): ${entry}`);
    continue;
  }
  cpSync(entry, `dist/${entry}`, { recursive: true });
  console.log(`kopiert: ${entry}`);
}
