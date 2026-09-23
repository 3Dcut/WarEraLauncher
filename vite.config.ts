import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// Daten- und Audiodateien liegen im Repo-Root und werden zur Laufzeit geladen.
// Der Dev-Server liefert sie direkt aus, für den Build kopiert scripts/copy-static.mjs sie nach dist/.
export default defineConfig({
  base: './',
  plugins: [preact()],
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
