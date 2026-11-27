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
- **Kurzlinks fürs Radio**: [warera.de/r](https://warera.de/r) startet das Hauptradio, `/n` die Nachtwache, `/a` den Azura-Livestream.
  Sperrt der Browser den Ton bis zur ersten Nutzeraktion, erscheint ein großer Startknopf.
- **Kisten-Battle** unter [warera.de/battle](https://warera.de/battle) (auch als Tool im Launcher), siehe unten.
- **Kisten-Assistent** unter [warera.de/cases](https://warera.de/cases) und **Marktcheck** unter [warera.de/market](https://warera.de/market)
  (beide auch als Tools im Launcher), siehe unten. Sie übernehmen den Spieler aus „Mein Charakter“.
- **WarEra-API-Schlüssel** einmal in den Einstellungen hinterlegen; eigene Tools nutzen ihn, fremde nach Freigabe.
- **Befehlspalette** mit <kbd>Strg</kbd>+<kbd>K</kbd>, Favoriten, zuletzt benutzte Tools, Tastenkürzel (<kbd>?</kbd> zeigt alle).
- **Sprachen**: Deutsch, Englisch und Schwedisch, umschaltbar in den Einstellungen, in der Befehlspalette oder per Adresse
  (`?lang=de`, `?lang=en`, `?lang=sv`). Ohne Angabe gilt die gespeicherte Wahl, sonst die Browsersprache; wer den Launcher
  schon vor der Übersetzung genutzt hat, bleibt bei Deutsch. Das Kisten-Battle (`/battle/`) folgt derselben Wahl.
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
  battle/             Kisten-Battle (eigene Seite unter /battle/)
  assist/             Gemeinsames der Werkzeugseiten: API-Zugriffe, Spielerwahl, SVG-Grafiken, Stil
  cases/              Kisten-Assistent (eigene Seite unter /cases/)
  market/             Marktcheck (eigene Seite unter /market/)
tests/                Vitest
public/r, /n, /a      Kurzlinks fürs Radio (leiten auf ?radio=… weiter)
scripts/              copy-static.mjs (Daten/Audio nach dist), check-tools.mjs (Erreichbarkeit/Einbettung)
```

## Kisten-Battle (`/battle`)

Umsetzung der [offiziellen Regeln des Case Battles Club](https://app.warera.io/article/6b04958ff12a5eba606a5875) (Nexuzu),
auf der Seite oben rechts verlinkt: zwei Spieler öffnen je eine rote Kiste pro Runde, die höhere Seltenheit gewinnt die Runde
(Gewöhnlich < Ungewöhnlich < Selten < Episch < Legendär < Mythisch), gleiche Seltenheit gibt keinen Punkt, FT3.
Die Oberfläche ist bewusst knapp: zwei Namen, Schalter Rot/Grün (Standard Rot, Grün als Ausweichmöglichkeit), Start.
FT3 und der Abfragetakt sind feste Regeln, keine Einstellungen.

- **Datenquelle**: `transaction.getPaginatedTransactions` mit `transactionType: "openCase"` und `itemCode` `case2` (rot) bzw.
  `case1` (grün) je Spieler. Die API gibt Transaktionen nur mit persönlichem Schlüssel heraus (Header `X-API-Key`).
- **Takt**: Beide Spieler stecken in einer gebündelten tRPC-Anfrage, 3 pro Sekunde (bis zu vier gleichzeitig). Mit Schlüssel
  erlaubt WarEra 500 Anfragen pro Minute, so bleibt Luft für die Preisabfragen; bei HTTP 429 wird automatisch langsamer abgefragt.
- **Bilanz** (Einsatz, Beute, Bilanz je Spieler): Einsatz ist der Kistenpreis beim Start (`itemTrading.getPrices`) mal gewertete
  Öffnungen. Ausrüstung hat keinen Marktpreis, sie wird Stück für Stück verkauft und kostet je nach Wurf deutlich mehr oder
  weniger. Jedes gezogene Item wird deshalb aus den letzten 100 Verkäufen desselben Codes geschätzt
  (`transactionType: "itemMarket"`, `itemCode`; jeder Verkauf trägt Preis, Werte und Zustand): Median der drei Verkäufe mit den
  nächsten Werten, Abstände bezogen auf die Spannen aus `gameConfig.items[code].dynamicStats`, identische Würfe zuerst. Ein
  Rückblicktest über 960 echte Verkäufe ergab im Median 0,3 % Abweichung (Durchschnittspreis je Code: 7,6 %). Ohne Schlüssel
  dient `gameStat.getEquipmentAvgByCode` als Rückfall. Marktsteuern sind nicht abgezogen.
- **Start**: Beim Start werden die letzten Öffnungen beider Spieler als Stand gemerkt (IDs und Serverzeit), nur Neues zählt.
  Mehrere auf einmal geöffnete Kisten werden der Reihe nach gewertet. Ein laufendes Battle übersteht Neuladen.
- **Link-Parameter** (etwa für OBS): `?a=Name&b=Name&kiste=rot|gruen&start=1`, `?demo=1` startet eine Demo mit den Quoten der
  roten Kiste, `?lang=de|en|sv` wählt die Sprache wie im Launcher.
- **Ereignisse für später (Cardera-Wetten)**: `start`, `open`, `round` und `finish` gehen als `CustomEvent('case-battle')` an das
  eigene Fenster und, wenn eingebettet, per `postMessage` (`source: "warera-case-battle"`) an die Elternseite.

Code: `src/battle/` (Logik in `logic.ts` mit Tests in `tests/battle-logic.test.ts`, Ablauf in `engine.ts`, Oberfläche in
`BattleApp.tsx`), Texte in `src/i18n/messages/battle.ts`, Einstieg `battle/index.html` als zweiter Vite-Einstieg.

## Kisten-Assistent (`/cases`)

Beobachtet live, welche roten (`case2`) und grünen (`case1`) Kisten der Spieler öffnet, und wertet die Sitzung aus. Der Spieler
kommt aus „Mein Charakter“ im Launcher (`wl2:settings`), wer ihn hier wechselt, wechselt ihn dort mit. Gezählt wird ab jetzt,
ab der letzten Stunde oder den letzten 24 Stunden; eine Sitzung übersteht Neuladen und lässt sich anhalten und fortsetzen.

- **Kennzahlen**: Kisten, Kosten (Marktpreis beim Öffnen), Erwartung, Wert nach Empfehlung (darunter „alles Schrott“ und
  „alles Verkauf“), Ergebnis und Glück. Dazu ein Verlauf mit Erwartung und üblichem Bereich (±1σ), Seltenheiten gegen
  Erwartung mit Wahrscheinlichkeit, Durststrecken und ein Band mit einer Zelle je Ziehung.
- **Verschrotten oder verkaufen**: Jedes Item wird wie im Kisten-Battle aus den letzten 100 Verkäufen desselben Codes
  geschätzt. Auf die Verkaufsliste kommt es nur, wenn die Schätzung den Schrottwert um beide einstellbaren Margen übertrifft
  (Prozent und fester Betrag, Standard 15 % und 1), weil Zerlegen weniger Arbeit macht; „ab …“ nennt den Preis, unter dem
  Zerlegen besser ist. Zerlegungen (`dismantleItem`, gleiche Item-ID) und Verkäufe (`itemMarket`, gleicher Code, gleiche Werte,
  `lastAcquisitionAt` zur Öffnung passend) werden erkannt und mit dem tatsächlichen Ergebnis gezählt.
- **Markt jetzt**: Geld- und Briefkurs beider Kisten und des Schrotts, Erwartungswert je Kiste nach Empfehlung. „Kaufen lohnt“,
  wenn der Erwartungswert über dem Brief liegt, „Lieber verkaufen“, wenn schon der Geldkurs mehr bringt. Schrott wird mit dem
  Mittel der letzten sieben Tage verglichen (`itemTrading.getItemTrading`).
- **Glück** wird in Schrott-Einheiten gemessen (unabhängig von Preisen) und mit simulierten Sitzungen gleicher Größe und
  gleicher Mischung verglichen.

Zahlen (Stand 2026-11-27):

| | Gewöhnlich | Ungewöhnlich | Selten | Episch | Legendär | Mythisch | Quelle |
|---|---|---|---|---|---|---|---|
| Rot (`case2`) | – | 50 % | 32 % | 15 % | 2,5 % | 0,5 % | Artikel „Opening Cases: Is It Actually Worth It?“, 4.000 Öffnungen aus der API: 49,8 / 32,4 / 15,2 / 2,1 / 0,55 % |
| Grün (`case1`) | 62 % | 30 % | 7,1 % | 0,85 % | 0,04 % | 0,01 % | [Artikel von Buffy_10](https://warera.io/en/articles/war-era-math-cases-to-scraps-is-it-actually-profitable-27ac2c), 4.000 Öffnungen: 61,6 / 29,7 / 7,8 / 0,8 / 0,1 / 0 % |
| Schrott (voll) | 6 | 18 | 54 | 162 | 486 | 1.458 | 1.500 `dismantleItem`-Transaktionen; abgenutzt `⌊Basis · (1 + 2 · Zustand/Max) / 3⌋` |

Je Seltenheit sind 30 % Waffen (`gameConfig.loot.weaponChancePercent`), der Rest verteilt sich gleich auf Helm, Brust, Hose,
Stiefel und Handschuhe. Link-Parameter: `?demo=1` startet eine Demo mit diesen Quoten, `?lang=de|en|sv` wie im Launcher.
Code: Logik in `src/cases/logic.ts` (Tests in `tests/cases-logic.test.ts`), Ablauf in `engine.ts`, Ableitungen in `stats.ts`.

## Marktcheck (`/market`)

Prüft die offenen Orders des Spielers auf Waren, Kisten und Schrott (`tradingOrder.getPublicOrdersByOwner`) gegen die Orderbücher
(`tradingOrder.getTopOrdersPerItemCode`) und den Tagesumsatz der letzten sieben Tage. Je Order: bester fremder Preis und wie
viele Orders davor stehen, Abstand zum 7-Tage-Mittel, Reichweite (Tage, bis Menge davor plus eigene Menge abverkauft wäre), Alter
und bisherige Füllungen (Handel mit gleichem `offerCreatedAt`). Hinweise: zu teuer, verschenkt Geld, steht lange, überschwemmt,
überboten, zu hoch geboten, jeweils mit Preisvorschlag.

Mit API-Schlüssel kommen die eigenen Ausrüstungsverkäufe der letzten 14 Tage dazu: Verkaufsdauer (Angebot bis Verkauf),
Preislage gegenüber dem Durchschnitt des Items beim Verkauf (ältere Transaktionen ohne `marketAvgPrice` gegen den aktuellen
Durchschnitt), ein Streudiagramm Dauer gegen Preislage und eine Übersicht je Item. Offene Ausrüstungsangebote und das Inventar
sperrt WarEra für API-Schlüssel (`itemOffer.getItemOffers`, `inventory.getInventory`: „API tokens cannot access this endpoint“);
stattdessen schätzt „Preis prüfen“ ein Item mit beliebigen Werten aus den letzten 100 Verkäufen und ordnet einen eigenen Preis ein.
Code: Logik in `src/market/logic.ts` (Tests in `tests/market-logic.test.ts`), Daten in `engine.ts`.

## WarEra-API-Schlüssel

Der persönliche Schlüssel (im Spiel unter Profil → Einstellungen → API-Tokens) wird einmal in den Einstellungen des Launchers
eingetragen und nur lokal gespeichert (`warera:apiKey`, absichtlich nicht unter `wl2:`, damit er beim Export der Einstellungen
nicht in der Datei landet; „Alles zurücksetzen“ löscht ihn mit). Er wird geprüft und an Tools weitergegeben:

- **Eigene Seiten unter warera.de** (Kisten-Battle, Kisten-Assistent, Marktcheck) lesen ihn direkt. Fehlt er dort, erscheint ein Feld, das ihn ebenfalls
  für den Launcher speichert.
- **Eingebettete fremde Tools** fragen per `postMessage` an. Beim ersten Mal fragt der Launcher nach, ob diese Herkunft den
  Schlüssel bekommen darf; die Entscheidung lässt sich in den Einstellungen wieder vergessen.

```js
// im eingebetteten Tool
window.parent.postMessage({ type: 'warera:api-key:request' }, '*');
window.addEventListener('message', (e) => {
  if (e.data?.type === 'warera:api-key') useKey(e.data.key); // null mit reason "denied" oder "missing"
});
```

Ändert sich der Schlüssel, bekommen freigegebene, offene Tools die neue Nachricht von selbst.

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

`name`, `url`, `desc`, `note` und `category` dürfen statt eines Strings ein Objekt je Sprache sein. Fehlt eine Sprache, gilt
zuerst Englisch, dann Deutsch. In URLs steht `{lang}` für die aktuelle Sprache:

```json
{ "id": "case-battle", "name": { "de": "Kisten-Battle", "en": "Case Battle", "sv": "Lådduell" },
  "url": "https://warera.de/battle/?lang={lang}",
  "desc": { "de": "Seltenere Kategorie punktet", "en": "The rarer category scores", "sv": "Den sällsyntare kategorin får poäng" } }
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
Einmal am Tag baut der Workflow neu, damit der Tool-Status aktuell bleibt.
