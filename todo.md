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

## v2.1 – Abgleich nach den Spiel-Updates (November 2026)
- [x] Case-EV-Rechner entfernt: Wooden Cases sind nicht mehr handelbar (`isTradable: false`), der Markt blendet nicht handelbare Waren aus
- [x] Mein Charakter: Balken aus `user.getUserSkills`, weil `user.getUserLite` keine Skills mehr liefert; Unternehmergeist durch Produktion ersetzt
- [x] Front: Turnierschlachten (Teams statt Länder) werden lesbar angezeigt
- [x] Tools entfernt: Wages (404), Income Calc (Domain abgelaufen, Jobmarkt und Unternehmergeist gibt es nicht mehr), Prod. Bonus (Deposits, Spezialisierung und Ethik-Boni seit v0.27 abgeschafft), Phantomant und CountryStats (Zertifikate seit Mai 2026 abgelaufen)
- [x] Build Tool zeigt auf intel.warera.wiki/builder, wie es die alte Seite selbst empfiehlt
- [x] Erreichbarkeits-Check: Browser prüft die Tools selbst, Build-Check täglich mit Statuscodes; nicht erreichbare Tools werden nicht angeboten (betrifft derzeit Market Monitor)
- [x] Nicht angepasste Tools per `"hidden"` ausgeblendet: Battle Sim (Unternehmergeist), Dismantle Calc und Nat. Companies (WarEra Toolkit 1.2.0, Jobmarkt-Löhne), WarEraStats (Datenquelle defekt)
- [ ] Ausgeblendete Tools gelegentlich prüfen und `hidden` entfernen, sobald sie aktualisiert sind
- [ ] /wahl/ bettet wahl.warera.de ein, die Subdomain hat keinen DNS-Eintrag mehr

## Ideen für später
- [ ] Englische Oberfläche (Texte liegen gesammelt in den Komponenten, Umstellung auf ein Wörterbuch nötig)
- [ ] AzuraCast-Status per SSE statt Polling
- [ ] Preisverlauf serverseitig (Cloudflare Worker, warera.de läuft bereits über Cloudflare)
- [ ] Schlafmodus für lange verdeckte Tools (Speicher sparen)
- [ ] Weitere Tools prüfen: intel.warera.wiki (Economy, Market, Military, Radar; bettet sich nicht ein), economic-build-warera.netlify.app
- [ ] Erinnerungen (z. B. Energie voll) als Browser-Benachrichtigung
