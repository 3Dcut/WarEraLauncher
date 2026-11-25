# WarEra Launcher

Leitstand für [WarEra](https://app.warera.io): Community-Tools, Live-Daten aus der offiziellen API und WarEra Radio
in frei anpassbaren Arbeitsbereichen. Läuft als statische Seite auf GitHub Pages (warera.de).

## Was die Oberfläche kann

- **Arbeitsbereiche** („Lage“, „Wirtschaft“, „Kampf“, „Statistik“, eigene) mit Tabs, Teilung, schwebenden Fenstern und
  Maximieren. Tools lassen sich aus der Seitenleiste auf Kanten oder in die Mitte eines Fensters ziehen.
- **Eingebettete Tools laden beim Verschieben nicht neu.** Dockview rendert jedes Iframe in einer festen Ebene
  (`renderer: 'always'`); Tabs im Hintergrund laden erst, wenn sie zum ersten Mal sichtbar werden.
- **Seiten, die Einbettung verbieten**, erscheinen als Karte mit „Als Fenster öffnen“ bzw. „Neuer Tab“.
- **Live-Widgets** über `api2.warera.io`: Zeiten (Regeneration, Tageswechsel, Missionen, Wahlen), Mein Charakter
  (Balken mit „voll um …“), Markt (Preise, lokaler Verlauf, Wert pro Produktionspunkt, Orderbuch), Front (laufende Schlachten).
- **Radio** als Pille in der Kopfleiste, als Widget und als Mini-Player (Document Picture-in-Picture, bleibt über dem Spiel);
  Automatik, Einspieler und Jingles wie bisher, dazu Medientasten/Sperrbildschirm (Media Session) und Hinweise, wenn ein Sender live geht.
- **Befehlspalette** mit <kbd>Strg</kbd>+<kbd>K</kbd>, Favoriten, zuletzt benutzte Tools, Tastenkürzel (<kbd>?</kbd> zeigt alle).
- **Sprachen**: Deutsch, Englisch und Schwedisch, umschaltbar in den Einstellungen, in der Befehlspalette oder per Adresse
  (`?lang=de`, `?lang=en`, `?lang=sv`). Ohne Angabe gilt die gespeicherte Wahl, sonst die Browsersprache; wer den Launcher
  schon vor der Übersetzung genutzt hat, bleibt bei Deutsch. Die Kisten-Seite (`/cases/`) folgt derselben Wahl.
- **Anpassung**: vier Themes (Grau, Feldgrau, Pink, Hell), eigene Akzentfarbe, Dichte, Glas-Effekt, Animationen;
  Layout als Link teilen, Einstellungen exportieren/importieren. Die alte Oberfläche bleibt unter `/legacy.html` erreichbar.

## Entwicklung

```bash
npm install
npm run dev        # Entwicklungsserver auf http://localhost:3456
npm test           # Radio-Logik und Datendateien prüfen
npm run check      # TypeScript
npm run build      # Ergebnis in dist/
npm run preview    # dist/ lokal ansehen
```

Stack: Vite, TypeScript, Preact mit Signals, [Dockview](https://dockview.dev) (MIT, Version fest eingetragen),
fuzzysort, Schriften lokal über Fontsource (keine Anfragen an Google Fonts).

```
src/
  main.tsx            Start: Daten laden, Arbeitsbereiche anlegen, Oberfläche rendern
  state.ts            Einstellungen, Favoriten, Toasts (Signals, localStorage unter "wl2:")
  i18n/               Sprachwahl, t()/tn()/tx(), Zahlen- und Datumsformate; messages/ enthält die Texte je Bereich
  theme.ts            Themes, Akzentfarbe, Theme-Wechsel mit View Transition
  data/tools.ts       Tool-Liste aus tools.json, Widgets, Status aus tools-status.json
  workspace/          Arbeitsbereiche, Vorlagen, Dockview-Anbindung, Panels (Iframe, Karte, Widget)
  radio/              Sender, reine Entscheidungslogik (getestet), Wiedergabe-Engine
  warera/             API-Client mit Cache, Spielzeiten
  widgets/            Zeiten, Charakter, Markt, Front
  ui/                 Kopfleiste, Seitenleiste, Palette, Einstellungen, Mini-Player
  styles/             Tokens (OKLCH), Grundlagen, Oberfläche, Dockview-Theme, Widgets
tests/                Vitest
scripts/              copy-static.mjs (Daten/Audio nach dist), check-tools.mjs (Erreichbarkeit/Einbettung)
```

## Daten pflegen (ohne Code)

Die JSON-Dateien im Repo-Root werden zur Laufzeit geladen und beim Deploy geprüft.

**tools.json**: Kategorien mit Tools. Pflicht sind `name` und `url`, empfohlen `id` (bleibt stabil, auch wenn der Name sich ändert).

```json
{ "id": "battle-sim", "name": "Battle Sim", "url": "https://battle-sim.warera.wiki", "emoji": "⚔️",
  "desc": "Schlachten simulieren", "tags": ["schlacht"], "embed": true }
```

`"embed": false` markiert Seiten, die sich nicht einbetten lassen. Das erkennt aber auch der wöchentliche Tool-Check von selbst.

`name`, `url`, `desc` und `category` dürfen statt eines Strings ein Objekt je Sprache sein. Fehlt eine Sprache, gilt
zuerst Englisch, dann Deutsch. In URLs steht `{lang}` für die aktuelle Sprache:

```json
{ "id": "case-ev", "name": "Case EV", "url": "https://warera.de/cases/?lang={lang}",
  "desc": { "de": "Erwartungswert einer Wooden Case", "en": "Expected value of a Wooden Case", "sv": "Väntevärde för en Wooden Case" } }
```

Dasselbe gilt für `name` und `desc` der Vorlagen in **workspaces.json**.

**workspaces.json**: Vorlagen für Arbeitsbereiche. Ein Layout besteht aus `row` (nebeneinander), `column` (untereinander)
und `tabs` (gestapelt). IDs sind Tool-IDs oder Widgets (`widget:timers`, `widget:character`, `widget:market`,
`widget:battles`, `widget:radio`). `defaults` legt fest, welche Vorlagen beim ersten Besuch als Arbeitsbereiche erscheinen.

**audio_schedule.json / radio_schedule.json**: unverändertes Format wie bisher. Uhrzeiten gelten in deutscher Zeit (Europe/Berlin).

## Texte übersetzen

Alle Texte der Oberfläche stehen in `src/i18n/messages/*.ts`, je Bereich eine Datei mit `de`, `en` und `sv`. Deutsch ist
die Quelle; TypeScript meldet fehlende oder überzählige Schlüssel, `tests/i18n.test.ts` prüft gleiche Platzhalter
(`{name}`), leere Texte und Mehrzahlformen (`….one`/`….other`). Eine weitere Sprache braucht einen Eintrag in `LANGS`
und eine Spalte in jeder Datei.

## Suchmaschinen & Linkvorschau

`index.html` enthält Titel, Beschreibung, Canonical, `hreflang`-Verweise auf `?lang=de|en|sv`, Open-Graph/Twitter-Tags (Vorschaubild `public/og-image.jpg`, 1200×630)
und strukturierte Daten (JSON-LD). Beim Build schreibt ein Vite-Plugin die Tools aus `tools.json` als Links in den
`<noscript>`-Block; `scripts/copy-static.mjs` erzeugt `sitemap.xml` samt Sprachfassungen. Titel, Beschreibung und Canonical
passt der Launcher zur Laufzeit an die Sprache an; der `<noscript>`-Block bleibt deutsch. `robots.txt` liegt in `public/`.
Die alte Oberfläche (`legacy.html`) ist auf `noindex` gesetzt und verweist per Canonical auf die Startseite.

## Deploy

Push auf `main` startet `.github/workflows/deploy.yml`: Typprüfung, Tests, Build, Tool-Check (schreibt `tools-status.json`),
Upload von `dist/` nach GitHub Pages. Schlägt ein Test fehl, bleibt die letzte funktionierende Version online.
Einmal pro Woche baut der Workflow neu, damit der Tool-Status aktuell bleibt.
