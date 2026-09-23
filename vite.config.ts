import { defineConfig, type Plugin } from 'vitest/config';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';

interface ToolEntry {
  name: string;
  url: string;
  desc?: string;
}

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// Schreibt die Tool-Liste aus tools.json als Links in den <noscript>-Block, damit auch
// Crawler ohne JavaScript sehen, was der Launcher enthält.
function seoToolList(): Plugin {
  return {
    name: 'seo-tool-list',
    transformIndexHtml(html) {
      const categories = JSON.parse(readFileSync('tools.json', 'utf8')) as { category: string; tools: ToolEntry[] }[];
      const list = categories
        .map(
          (c) =>
            `<h3>${escapeHtml(c.category)}</h3><ul>${c.tools
              .map((t) => `<li><a href="${escapeHtml(t.url)}" rel="noopener">${escapeHtml(t.name)}</a>${t.desc ? ` – ${escapeHtml(t.desc)}` : ''}</li>`)
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
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  server: { port: 3456 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
