import { defineConfig, type Plugin } from 'vitest/config';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Text = string | Record<string, string>;

interface ToolEntry {
  name: Text;
  url: Text;
  desc?: Text;
}

/** Der <noscript>-Block ist deutsch; mehrsprachige Einträge liefern deshalb ihre deutsche Fassung. */
const de = (value: Text | undefined): string =>
  value == null ? '' : typeof value === 'string' ? value : (value.de ?? value.en ?? Object.values(value)[0] ?? '');

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// Schreibt die Tool-Liste aus tools.json als Links in den <noscript>-Block, damit auch
// Crawler ohne JavaScript sehen, was der Launcher enthält.
function seoToolList(): Plugin {
  return {
    name: 'seo-tool-list',
    transformIndexHtml(html) {
      const categories = JSON.parse(readFileSync('tools.json', 'utf8')) as { category: Text; tools: ToolEntry[] }[];
      const list = categories
        .map(
          (c) =>
            `<h3>${escapeHtml(de(c.category))}</h3><ul>${c.tools
              .map((t) => {
                const url = de(t.url).replace(/\{lang\}/g, 'de');
                const desc = de(t.desc);
                return `<li><a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(de(t.name))}</a>${desc ? ` – ${escapeHtml(desc)}` : ''}</li>`;
              })
              .join('')}</ul>`,
        )
        .join('');
      return html.replace('<!--seo-tools-->', list);
    },
  };
}

// Daten- und Audiodateien liegen im Repo-Root und werden zur Laufzeit geladen.
// Der Dev-Server liefert sie direkt aus, für den Build kopiert scripts/copy-static.mjs sie nach dist/.
export default defineConfig({
  base: './',
  plugins: [preact(), seoToolList()],
  build: {
    target: 'es2022',
    rollupOptions: {
      // Zweiter Einstieg: das Kisten-Battle als eigene Seite unter /battle/
      input: { main: resolve(import.meta.dirname, 'index.html'), battle: resolve(import.meta.dirname, 'battle/index.html') },
    },
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  server: { port: 3456 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
