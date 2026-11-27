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

## v2.2 – Abgleich nach den Spiel-Updates (November 2026)
- [x] Case-EV-Rechner entfernt: Wooden Cases sind nicht mehr handelbar (`isTradable: false`), der Markt blendet nicht handelbare Waren aus
- [x] Mein Charakter: Balken aus `user.getUserSkills`, weil `user.getUserLite` keine Skills mehr liefert; Unternehmergeist durch Produktion ersetzt
- [x] Front: Turnierschlachten (Teams statt Länder) werden lesbar angezeigt
- [x] Tools entfernt: Wages (404), Income Calc (Domain abgelaufen, Jobmarkt und Unternehmergeist gibt es nicht mehr), Prod. Bonus (Deposits, Spezialisierung und Ethik-Boni seit v0.27 abgeschafft), Phantomant und CountryStats (Zertifikate seit Mai 2026 abgelaufen)
- [x] Build Tool zeigt auf intel.warera.wiki/builder, wie es die alte Seite selbst empfiehlt
- [x] Erreichbarkeits-Check: Browser prüft die Tools selbst, Build-Check täglich mit Statuscodes; nicht erreichbare Tools werden nicht angeboten (betrifft derzeit Market Monitor)
- [x] Nicht angepasste Tools per `"hidden"` ausgeblendet: Battle Sim (Unternehmergeist), Dismantle Calc und Nat. Companies (WarEra Toolkit 1.2.0, Jobmarkt-Löhne), WarEraStats (Datenquelle defekt)
- [ ] Ausgeblendete Tools gelegentlich prüfen und `hidden` entfernen, sobald sie aktualisiert sind
- [ ] /wahl/ bettet wahl.warera.de ein, die Subdomain hat keinen DNS-Eintrag mehr

## v2.3 – Kisten-Battle, Radio-Kurzlinks und API-Schlüssel
- [x] Kisten-Battle unter /battle nach den offiziellen Regeln (rote Kisten, FT3): nur Namen, Schalter Rot/Grün, Start; Live-Erkennung aus openCase-Transaktionen
- [x] Gebündelte Abfragen (bis 8/s, Drosselung bei 429), Stand beim Start, Warteschlange bei Mehrfachöffnungen, Fortsetzen nach Neuladen
- [x] Animationen (Kiste wackelt, Strahlen, Konfetti, Banner bei Legendär/Mythisch, Siegerkrone), Töne per Web Audio, Demo-Modus
- [x] Kurzlinks warera.de/r, /n, /a starten Hauptradio, Nachtwache, Azura; Startknopf, wenn Autoplay gesperrt ist
- [x] WarEra-API-Schlüssel in den Einstellungen, lokal gespeichert, für eigene Tools direkt, für eingebettete Tools per postMessage nach Freigabe
- [x] Kisten-Battle auf Deutsch, Englisch und Schwedisch (Wörterbuch src/i18n/messages/battle.ts; Schwedisch gegenlesen lassen)

## v2.4 – Kisten-Assistent und Marktcheck
- [x] Kisten-Assistent unter /case: Live-Tracking roter und grüner Kisten des aktiven Spielers, Kosten, Erwartung, Schrott- und Verkaufswert, Glück, Verlauf, Seltenheiten, Durststrecken
- [x] Empfehlung verschrotten oder verkaufen mit Marge in Prozent und absolut; Zerlegungen und Verkäufe werden erkannt
- [x] Kisten- und Schrottmarkt: Geld/Brief, Erwartungswert je Kiste, Kauf- bzw. Verkaufsempfehlung, Schrott gegen 7-Tage-Mittel
- [x] Marktcheck unter /items: offene Orders gegen Orderbuch, Umsatz und Füllungen; Ausrüstungsverkäufe nach Dauer und Preislage; Preis-Check
- [ ] Offene Ausrüstungsangebote anzeigen, sobald WarEra itemOffer.getItemOffers für API-Schlüssel freigibt
- [ ] Marktsteuern berücksichtigen, falls sie sich aus den Transaktionen ablesen lassen
- [ ] Schwedische Texte gegenlesen lassen (Kisten-Assistent, Marktcheck)

## v2.5 – Kisten-Assistent: lange Zeiträume
- [x] Zeiträume 7 Tage, 30 Tage, ab Datum und ab Beginn der Aufzeichnung; Nachladen im Hintergrund von neu nach alt mit Fortschritt, „Laden beenden“ und „Weiter laden“
- [x] Die Sitzung erscheint nach der ersten Seite und füllt sich laufend; je Schritt eine gebündelte Anfrage für Öffnungen, Zerlegungen und Verkäufe (zählt einmal gegen das Limit von 500 je Minute)
- [x] Zerlegungen und Verkäufe über den ganzen Zeitraum den Ziehungen zuordnen, in beliebiger Ankunftsreihenfolge (Item-ID, bei Verkäufen Code, Werte und `lastAcquisitionAt`); an 3Dsus geprüft: 40.812 von 40.836 Zerlegungen und 587 von 590 Verkäufen von Items aus dem Fenster passten
- [x] Kosten zum Tagesmittel des Öffnungstags, Schrott zum Tagespreis der Zerlegung (die rote Kiste stieg in 30 Tagen um etwa 20 %)
- [x] Für zehntausende Kisten: Zeilen-Cache, ausgedünnter Verlauf, begrenztes Zellband und Verkaufsliste, Glück per Normalnäherung mit Schiefekorrektur, Speicherung ohne Ziehungen bei großen Sitzungen
- [x] Nachladen beschleunigen: mehrere Zeitscheiben parallel lesen, mit selbst gebauten Cursorn (Zeit, `000…`) und bis zu 24 Aufrufen je Anfrage; fällt auf sequentielles Lesen zurück, wenn der Server die Cursor ablehnt. 7 Tage bei 3Dsus: 62 s statt 8,5 min
- [x] Eine Million Kisten: Spaltenspeicher (32 Byte je Ziehung), Zuordnung über Hash-Tabellen, Aggregation in einem Durchlauf, Verlauf in 1.200 Fächern mit Hülle und Zellband auf Canvas, alles ohne Ausdünnen. 958.542 echte Kisten von 3Dsus in 5,3 min geladen, 1,04 Millionen virtuelle in 5 min bei 350 MB im Renderer
- [x] Zerlegung (eindeutige Item-ID) hat Vorrang vor einem Verkauf gleichwertiger Ziehungen, das Ergebnis hängt nicht von der Ankunftsreihenfolge ab
- [ ] Zwei gebündelte Anfragen gleichzeitig: das Limit von 360 je Minute ist beim Nachladen nur zu rund 70 % ausgelastet, bei einer Million Kisten ließen sich so etwa anderthalb Minuten sparen
- [ ] Nachgeladene Sitzungen in IndexedDB zwischenspeichern, damit ein Neuladen nicht alles neu holt
- [ ] Schwedische Texte des Nachladens gegenlesen lassen
- [ ] Info-Blasen (`InfoTip`) ragen auf dem Handy bis zu 24 px über den rechten Seitenrand und erzeugen waagerechtes Scrollen (schon vor dem Nachladen vorhanden)

## Ideen für später
- [ ] Kisten-Battle mit Cardera verbinden: Gems setzen und auf den Sieger wetten (Ereignisse und Schlüsselweitergabe sind vorbereitet)
- [ ] Kisten-Battle als Turnier (mehrere Paarungen, Rangliste)
- [ ] AzuraCast-Status per SSE statt Polling
- [ ] Preisverlauf serverseitig (Cloudflare Worker, warera.de läuft bereits über Cloudflare)
- [ ] Schlafmodus für lange verdeckte Tools (Speicher sparen)
- [ ] Weitere Tools prüfen: intel.warera.wiki (Economy, Market, Military, Radar; bettet sich nicht ein), economic-build-warera.netlify.app
- [ ] Erinnerungen (z. B. Energie voll) als Browser-Benachrichtigung
