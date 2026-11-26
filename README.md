# WarEra Launcher

Leitstand für [WarEra](https://app.warera.io): Community-Tools, Live-Daten aus der offiziellen API und WarEra Radio
in frei anpassbaren Arbeitsbereichen. Läuft als statische Seite auf GitHub Pages (warera.de).

## Was die Oberfläche kann

- **Arbeitsbereiche** („Lage“, „Wirtschaft“, „Kampf“, „Statistik“, eigene) mit Tabs, Teilung, schwebenden Fenstern und
  Maximieren. Tools lassen sich aus der Seitenleiste auf Kanten oder in die Mitte eines Fensters ziehen.
- **Eingebettete Tools laden beim Verschieben nicht neu.** Dockview rendert jedes Iframe in einer festen Ebene
  (`renderer: 'always'`); Tabs im Hintergrund laden erst, wenn sie zum ersten Mal sichtbar werden.
- **Seiten, die Einbettung verbieten**, erscheinen als Karte mit „Als Fenster öffnen“ bzw. „Neuer Tab“.
- **Nur erreichbare Tools werden angeboten.** Der Browser prüft die Tools selbst (beim Start, danach alle paar Minuten),
  der tägliche Build-Check ergänzt Statuscodes. Was nicht gültig erreichbar ist, verschwindet aus Seitenleiste, Palette
  und Vorlagen und kommt von selbst zurück, sobald es wieder antwortet. Bereits offene Panels zeigen stattdessen eine Karte mit dem Grund.
- **Live-Widgets** über `api2.warera.io`: Zeiten (Regeneration, Tageswechsel, Missionen, Wahlen), Mein Charakter
  (Balken mit „voll um …“), Markt (Preise, lokaler Verlauf, Wert pro Produktionspunkt, Orderbuch), Front (laufende Schlachten).
- **Radio** als Pille in der Kopfleiste, als Widget und als Mini-Player (Document Picture-in-Picture, bleibt über dem Spiel);
  Automatik, Einspieler und Jingles wie bisher, dazu Medientasten/Sperrbildschirm (Media Session) und Hinweise, wenn ein Sender live geht.
- **Befehlspalette** mit <kbd>Strg</kbd>+<kbd>K</kbd>, Favoriten, zuletzt benutzte Tools, Tastenkürzel (<kbd>?</kbd> zeigt alle).
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

## WarEra-API

Die Widgets lesen die öffentliche tRPC-API unter `api2.warera.io` (ohne Schlüssel, 100 Anfragen pro Minute und IP).
Welche Prozeduren es gibt, welche Parameter sie erwarten und was sich nach einem Spiel-Update geändert hat
(neue Felder, entfernte Prozeduren), steht im [API-Explorer von RealMarijn](https://warera.realmarijn.nl/api-explorer).
Nach größeren Updates lohnt ein Abgleich mit `src/warera/api.ts`.

## Daten pflegen (ohne Code)

Die JSON-Dateien im Repo-Root werden zur Laufzeit geladen und beim Deploy geprüft.

**tools.json**: Kategorien mit Tools. Pflicht sind `name` und `url`, empfohlen `id` (bleibt stabil, auch wenn der Name sich ändert).

```json
{ "id": "battle-sim", "name": "Battle Sim", "url": "https://battle-sim.warera.wiki", "emoji": "⚔️",
  "desc": "Schlachten simulieren", "tags": ["schlacht"], "embed": true }
```

`"embed": false` markiert Seiten, die sich nicht einbetten lassen. Das erkennt aber auch der tägliche Tool-Check von selbst.

`"hidden": true` blendet ein Tool vorübergehend aus, etwa wenn es nicht an das aktuelle Spiel angepasst ist; `"note"` nennt
den Grund (Pflicht bei ausgeblendeten Tools, der Test prüft das). Vorlagen dürfen ausgeblendete Tools weiter enthalten,
sie fallen beim Aufbau weg und kehren zurück, sobald `hidden` entfernt wird.

Ob ein Tool angeboten wird, entscheidet `unavailableReason` in `src/data/tools.ts`: ausgeblendet, 404 oder Serverfehler aus
dem Build-Check schließen es immer aus; ob die Seite gerade erreichbar ist (DNS, Zertifikat, Verbindung), prüft der Browser
in `src/data/reachability.ts` per `HEAD`-Anfrage ohne Cookies und Referrer. Die Tool-Seiten sehen dadurch eine kurze Anfrage
von jeder Person, die den Launcher öffnet.

**workspaces.json**: Vorlagen für Arbeitsbereiche. Ein Layout besteht aus `row` (nebeneinander), `column` (untereinander)
und `tabs` (gestapelt). IDs sind Tool-IDs oder Widgets (`widget:timers`, `widget:character`, `widget:market`,
`widget:battles`, `widget:radio`). `defaults` legt fest, welche Vorlagen beim ersten Besuch als Arbeitsbereiche erscheinen.

**audio_schedule.json / radio_schedule.json**: unverändertes Format wie bisher. Uhrzeiten gelten in deutscher Zeit (Europe/Berlin).

## Suchmaschinen & Linkvorschau

`index.html` enthält Titel, Beschreibung, Canonical, Open-Graph/Twitter-Tags (Vorschaubild `public/og-image.jpg`, 1200×630)
und strukturierte Daten (JSON-LD). Beim Build schreibt ein Vite-Plugin die Tools aus `tools.json` als Links in den
`<noscript>`-Block; `scripts/copy-static.mjs` erzeugt `sitemap.xml`. `robots.txt` liegt in `public/`.
Die alte Oberfläche (`legacy.html`) ist auf `noindex` gesetzt und verweist per Canonical auf die Startseite.

## Deploy

Push auf `main` startet `.github/workflows/deploy.yml`: Typprüfung, Tests, Build, Tool-Check (schreibt `tools-status.json`),
Upload von `dist/` nach GitHub Pages. Schlägt ein Test fehl, bleibt die letzte funktionierende Version online.
Einmal am Tag baut der Workflow neu, damit der Tool-Status aktuell bleibt.
