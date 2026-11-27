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

// Sitemap mit dem Build-Datum und den Sprachfassungen (?lang=); die alte Oberfläche und die Radio-Kurzlinks sind per noindex ausgenommen
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  'dist/sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${['', '?lang=de', '?lang=en', '?lang=sv']
  .map(
    (q) => `  <url>
    <loc>https://warera.de/${q}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${q ? '0.8' : '1.0'}</priority>
    <xhtml:link rel="alternate" hreflang="de" href="https://warera.de/?lang=de" />
    <xhtml:link rel="alternate" hreflang="en" href="https://warera.de/?lang=en" />
    <xhtml:link rel="alternate" hreflang="sv" href="https://warera.de/?lang=sv" />
    <xhtml:link rel="alternate" hreflang="x-default" href="https://warera.de/" />
  </url>`,
  )
  .join('\n')}
${['battle', 'cases', 'market']
  .map(
    (page) => `  <url>
    <loc>https://warera.de/${page}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`,
);
console.log('geschrieben: sitemap.xml');
