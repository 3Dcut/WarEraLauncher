// Kopiert Daten-, Audio- und Zusatzdateien unverändert nach dist/, damit sie zur Laufzeit
// geladen und weiterhin ohne Code-Änderung gepflegt werden können.
import { cpSync, existsSync, writeFileSync } from 'node:fs';

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

// Sitemap mit dem Build-Datum; die alte Oberfläche ist per noindex ausgenommen
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  'dist/sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://warera.de/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`,
);
console.log('geschrieben: sitemap.xml');
