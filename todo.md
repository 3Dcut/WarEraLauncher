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

## Ideen für später
- [ ] Englische Oberfläche (Texte liegen gesammelt in den Komponenten, Umstellung auf ein Wörterbuch nötig)
- [ ] AzuraCast-Status per SSE statt Polling
- [ ] Preisverlauf serverseitig (Cloudflare Worker, warera.de läuft bereits über Cloudflare)
- [ ] Schlafmodus für lange verdeckte Tools (Speicher sparen)
- [ ] Weitere Tools prüfen: intel.warera.wiki, economic-build-warera.netlify.app
- [ ] Erinnerungen (z. B. Energie voll) als Browser-Benachrichtigung
