# WarEra Launcher – Entwicklungsstand

## v1.0 – Grundgerüst (legacy.html)
- [x] Toolbar mit Kategorien, Tools als Iframe-Spalten, Radio mit Automatik und Einspielern, Themes Grau/Pink

## v2.0 – Arbeitsbereiche
- [x] Statuskorrekturen Radio: "inaktiv" galt als online, Icecast-Platzhalter galt als Live-DJ
- [x] Songtitel per textContent statt innerHTML (XSS)
- [x] Vite + TypeScript + Preact, Tests für Radio-Logik und Datendateien, Deploy nur bei grünem Build
- [x] Arbeitsbereiche mit Dockview: Tabs, Teilen, schwebende Fenster, Maximieren, Drag & Drop aus der Seitenleiste
- [x] Iframes bleiben beim Verschieben, Stapeln, Lösen und Bereichswechsel erhalten (im Browser getestet)
- [x] Vorlagen (Lage, Wirtschaft, Kampf, Statistik), Layout als Link teilen, Übernahme offener Tools aus v1
- [x] Karten für nicht einbettbare Seiten, wöchentlicher Tool-Check (erreichbar/einbettbar)
- [x] Widgets über die WarEra-API: Zeiten, Mein Charakter, Markt, Front
- [x] Radio-Engine neu: Zustände, Verbindungsfrist, Medientasten (Media Session), Mini-Player (Picture-in-Picture), Live-Hinweise
- [x] Befehlspalette, Favoriten, Zuletzt benutzt, Tastenkürzel, Hilfe
- [x] Themes Grau, Feldgrau, Pink, Hell, eigene Akzentfarbe, Dichte, Glas, Animationen; Export/Import
- [x] Mobil: ein Fenster mit Tabs, Werkzeuge als Schublade
- [x] Schriften lokal (keine Google-Fonts-Anfragen), PWA-Manifest

## v2.1 – Sprachen
- [x] Wörterbuch je Bereich (src/i18n/messages), Deutsch, Englisch, Schwedisch; Wahl in Einstellungen, Palette und per ?lang=
- [x] Tool-Beschreibungen, Kategorien und Vorlagen mehrsprachig, Tool-URLs mit {lang}
- [x] Kisten-Seite (/cases/) übersetzt; alte Oberfläche (legacy.html) bleibt deutsch
- [ ] Schwedische Texte von Muttersprachlern gegenlesen lassen

## v2.2 – Kisten-Battle und Radio-Kurzlinks
- [x] Kisten-Battle unter /battle: Spieler per Name, Profil-Link oder ID, Live-Erkennung aus openCase-Transaktionen
- [x] Gebündelte Abfragen (bis 8/s, Drosselung bei 429), Stand beim Start, Warteschlange bei Mehrfachöffnungen, Fortsetzen nach Neuladen
- [x] Animationen (Kiste wackelt, Strahlen, Konfetti, Banner bei Legendär/Mythisch, Siegerkrone), Töne per Web Audio, Demo-Modus
- [x] Kurzlinks warera.de/r, /n, /a starten Hauptradio, Nachtwache, Azura; Startknopf, wenn Autoplay gesperrt ist
- [x] Kisten-Battle auf Deutsch, Englisch und Schwedisch (Wörterbuch src/i18n/messages/battle.ts; Schwedisch gegenlesen lassen)

## Ideen für später
- [ ] Kisten-Battle mit Cardera verbinden: Gems setzen und auf den Sieger wetten (Ereignisse und Tipp-Platzhalter sind vorbereitet)
- [ ] Kisten-Battle als Turnier (mehrere Paarungen, Rangliste)
- [ ] AzuraCast-Status per SSE statt Polling
- [ ] Preisverlauf serverseitig (Cloudflare Worker, warera.de läuft bereits über Cloudflare)
- [ ] Schlafmodus für lange verdeckte Tools (Speicher sparen)
- [ ] Weitere Tools prüfen: intel.warera.wiki, economic-build-warera.netlify.app
- [ ] Erinnerungen (z. B. Energie voll) als Browser-Benachrichtigung
