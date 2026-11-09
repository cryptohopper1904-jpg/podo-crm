# Design-Review: Website-Entwurf Podologie Kiehne

Stand: 09.11.2026 · Gegenstand: `website-vorschau.html` (Version 1, vor Überarbeitung)
Anlass: Rückmeldung der Kundin – der Entwurf wirke „unstimmig, wie ein Fremdkörper“.

## Vorgehen

1. Playwright-Screenshots der Version 1: Desktop 1440 px, iPad 1024 px, iPhone 390 px, jeweils hell und dunkel (ganze Seite und sichtbarer Bereich).
2. Unabhängige Kritik durch drei externe Bildmodelle (über OpenRouter), jeweils mit Logo, Praxisfotos und den Screenshots, gleiche Fragestellung auf Deutsch:
   `openai/gpt-5.6-sol`, `~google/gemini-pro-latest`, `x-ai/grok-4.7` – alle drei haben geantwortet.
3. Eigene Kritik (Claude).
4. Konsolidierte Maßnahmenliste → umgesetzt in Version 2.

Messwerte aus dem Logo (Pixel-Auswertung): Königsblau **#2356A5**, Türkis/Petrol **#21A69B**, Grün (Plus, Tagline) **#6AB973**.
Messwerte Version 1: kein horizontaler Scroll in allen Größen; Grundschrift 17 px; Überschriften Fraunces (Serife, kursiv); Logo in weißer Kachel; Hintergrund kühles Graublau #F6F9FC; Dark Mode aktiv.

---

## Eigene Kritik (Claude)

**Markenkohärenz.** Drei Gestaltungssysteme liegen übereinander: das Logo (geometrische Grotesk, Blau→Türkis-Verlauf, grünes Plus), die echte Praxis (Weiß, helle Eiche, warmes Licht, Holzlamellen) und ein generisches SaaS-Template (kühles Graublau, redaktionelle Serife, Pillen-Tags). Die Seite übernimmt aus dem Logo nur das Blau; Türkis kommt gar nicht vor, das Grün nur als Datumsfarbe und Entwurfsbanner. Die CSS-Variablen heißen noch `--sage`/`--peach` – Reste eines anderen Themes, die man an der Farbwahl spürt.

**Logo.** Die weiße Kachel mit 10 px Radius auf getöntem, halbtransparentem Header ist genau der „aufgeklebte“ Eindruck. Das Logo-PNG ist bereits freigestellt – die Kachel ist unnötig. Im Dark Mode wird es extrem (weißes Rechteck auf Nachtblau). Da das Logo dunkelblaue Schrift hat und sich auf Dunkel nicht ohne zweite Logo-Variante zeigen lässt, ist eine **bewusst helle Seite** die ehrliche Lösung.

**Typografie.** Fraunces mit Kursiv-Akzent („*in der Praxis*“) ist eine Magazin-Geste und widerspricht der kantig-geometrischen Wortmarke. 17 px Fließtext, 15–15,5 px in Karten und 13–14 px in Pills/Bildunterschriften sind für die Zielgruppe (ältere Menschen, Diabetiker mit möglicher Retinopathie) zu klein; viel Text ist zudem mittelgrau (#52627F) auf Graublau.

**Hero.** Das Fassadenfoto ist ein kleiner, schmal beschnittener Landschaftsausschnitt (Hecke, Fenster), darunter eine separate weiße Karte mit grünem Datum – zwei Objekte ohne gemeinsame Kante. Das Originalfoto ist hochformatig und zeigt das ganze Haus mit Schild „PODOLOGIE“ und Hausnummer 68 – genau das Wiedererkennungsbild für Patientinnen, die die Praxis suchen. Es sollte groß und mit Adresse verbunden gezeigt werden.

**Inhaltlicher Zeitbezug.** Heute ist der 09.11.2026 – die Praxis ist bereits eröffnet. „Neu 1.11.2026 · Unsere neue Praxis öffnet“ liest sich wie eine Ankündigung. Besser: „Neu eröffnet – seit 1. November 2026 in der Goethestraße 68“.

**Handlungsaufforderung.** Drei verschiedene Termin-Buttons („Termin buchen“, „Online-Termin vereinbaren“, „Jetzt Termin wählen“), aber die Online-Buchung ist noch nicht aktiv – der primäre Weg führt ins Leere. Die Telefonnummer – für die Zielgruppe der wichtigste Kanal – steht erst ganz unten und ist kein `tel:`-Link, sondern ein „Nummer kopieren“-Button (Software-Muster, nicht Praxis-Muster).

**Vertrauen.** Die Signale sind vorhanden (staatlich anerkannt, Heilpraktikerin, Bundesverband, Hygieneraum-Foto), aber als kleine graue Pills bzw. dritte Bildunterschrift versteckt. Das Hygiene-Foto (Thermodesinfektor/Sterilisator, Spender, Holz-Arbeitsplatte) ist ein starkes Argument und verdient eine eigene Rolle.

**Porträt.** Rundes 180-px-Avatar wirkt wie ein Profilbild in einer App. Victoria Kiehne ist das Gesicht der Praxis – das Porträt sollte groß, warm und mit persönlicher Ansprache in der Ich-Form stehen.

**Mobil.** Navigation verschwindet ersatzlos (kein Menü), Logo-Tagline in der Kachel unlesbar klein, das Foto beginnt erst nach dem zweiten Bildschirm, Telefon nicht erreichbar.

**Kleinigkeiten.** Leere `<p>` im Über-uns-Block; Fokusfarbe Grün auf Weiß mit geringem Kontrast; Tabelle der Zeiten ohne Überschriftenzeile/`th`; Impressum/Datenschutz-Links zeigen auf nicht vorhandene Anker; „Termin“-Abschnitt dupliziert Kontakt.

---

## Externe Kritiken (wörtlich, unverändert)

### OpenAI GPT-5.6 Sol (`openai/gpt-5.6-sol`)

#### 1) Markenkohärenz mit Logo und Interieur
Der Entwurf wirkt klinisch-kühl und editorial, während Logo und Praxisräume modern, freundlich und warm sind. Besonders im Dark Mode erscheint das Logo durch die weiße Trägerfläche „aufgeklebt“. Das Fassadenfoto transportiert zudem weniger Qualität als Empfang, Behandlungsraum oder Porträt.

**Empfehlung:** Helle Eiche, warmes Weiß und Petrol aus Logo/Interieur als Gestaltungssystem übernehmen. Im Hero Victoria Kiehne oder den Empfang zeigen; die Außenansicht kleiner bei Anfahrt/Kontakt platzieren. Logo als transparente SVG-Datei ohne weiße Karte einsetzen.

#### 2) Typografie
Die Serifenschrift erzeugt einen hochwertigen, aber eher magazinartigen Charakter und widerspricht der geometrischen Wortmarke. Kursivierungen verstärken den Stilbruch.

**Empfehlung:** Durchgehend eine klare Sans verwenden, z. B. **Manrope**, **Montserrat** oder **Plus Jakarta Sans** für Überschriften; **Source Sans 3** für Fließtext. Headlines kräftig statt kursiv. Mindestgröße Fließtext 18 px, Zeilenhöhe 1,55–1,65.

#### 3) Farbe
Blau ist passend, das blasse Graublau wirkt jedoch etwas steril. Das Logo-Grün wird fast nur beim Datum genutzt. Der Dark Mode passt weder zur hellen Praxis noch zur älteren Zielgruppe und verschlechtert teilweise die Lesbarkeit.

**Palette:** Königsblau `#2458A6`, Petrol `#168F95`, Grün `#43A65B`, warmes Weiß `#FAF8F3`, Holzton `#D8C2A6`, Text `#17233A`. Grün nur für positive Hinweise, nicht für kleine Texte. Dark Mode zunächst weglassen.

#### 4) Layout & Hierarchie
Hero-Text, Fassadenbild und Eröffnungskarte stehen nebeneinander, erzählen aber keine gemeinsame Geschichte. Die Eröffnung konkurriert mit dem Hauptnutzen.

**Lösung:** Hero als klare Einheit: Aussage + Qualifikation + CTAs links, warmes Praxis-/Porträtfoto rechts. Eröffnung als horizontales Badge direkt am Bild: „Neue Praxis ab 01.11.2026 · Goethestraße 68“. Danach Leistungen, Hausbesuche, Vertrauen, Termin/Kontakt.

#### 5) Vertrauenssignale für ältere Patienten
Gut sind Qualifikation, Hygiene-Einblick und echte Fotos. Es fehlen sofort sichtbare praktische Informationen: **Telefonnummer**, Barrierefreiheit, Parken/ÖPNV, Kosten bzw. Privat/Selbstzahler, Hausbesuchsgebiet und Terminablauf. Telefonischen Termin gleichwertig zur Online-Buchung anbieten.

#### 6) Mobil
Headline und Abstände sind überdimensioniert; Foto und Eröffnungsinformation liegen zu weit unten. Logo und Button wirken wie zwei große Kacheln. Navigation/Telefon fehlen.

**Lösung:** H1 ca. 40–44 px, kürzerer Text, kompakter Header mit Logo, Telefon-Icon und Menü. Sticky Leiste: „Anrufen“ / „Termin“. Eröffnungsbadge direkt vor oder auf dem Hero-Foto.

#### 7) Top-5-Maßnahmen
1. **Logo wirkt aufgeklebt →** transparente SVG, größer und ohne weiße Box.  
2. **Schriftbruch →** Serifenschrift durch Manrope/Source Sans 3 ersetzen.  
3. **Unverbundener Hero →** echtes Innenraum-/Porträtfoto plus integriertes Eröffnungsbadge.  
4. **Zu klinische Farbwelt →** warmes Weiß und Holzton ergänzen, Dark Mode streichen.  
5. **Zu wenig Alltagssicherheit →** Telefon, Qualifikation, Kostenstatus, Barrierefreiheit und Hausbesuchsgebiet oberhalb der Falz zeigen.

---

### Google Gemini Pro (latest) (`~google/gemini-pro-latest`)

Das Bauchgefühl von Frau Kiehne ist absolut richtig: Der Entwurf sieht nach einem generischen SaaS-Template aus, nicht nach ihrer echten, warm gestalteten Praxis.

#### 1) Markenkohärenz (Logo & Interieur)
* **Logo als Fremdkörper:** Das Logo sitzt in einer weißen Box auf graublauem Grund (im Dark Mode noch extremer) – es wirkt wie ein Platzhalter-Aufkleber.
* **Bruch zum Interieur:** Die echten Praxisräume strahlen durch **helle Eiche, warmes Licht und klare Linien** Ruhe und Geborgenheit aus. Die Website dagegen wirkt kühl-klinisch (Eisblau/Schiefer). Das kühle Außenfoto der rosafarbenen Fassade im Hero verstärkt diesen Bruch.

#### 2) Typografie
* **Stilbruch:** Die kräftige, geometrische Sans-Serif der Logo-Wortmarke kollidiert hart mit der redaktionellen Serifenschrift (inkl. kursiver Auszeichnung) in den Überschriften. 
* **Lesbarkeit:** Für ältere Menschen und Diabetiker (oft mit Sehbeeinträchtigung) ist eine klare, humanistische oder geometrische Sans-Serif deutlich besser lesbar.

#### 3) Farbe
* Das Logo liefert eine starke Palette: **Königsblau (`#1E4E9D`), Petrol/Türkis (`#1B998B`) und Salbeigrün (`#68B684`)**. Der Entwurf nutzt fast nur ein kaltes Standard-Blau.
* Der **Dark Mode** (`#0B1324`) wirkt technisch-kühl und ist für eine lokale Gesundheitspraxis mit Fokus Senioren unpassend – besser komplett streichen.

#### 4) Layout & Hierarchie
* **Hero-Rechts:** Das Hausfoto und die „Neu 1.11.2026“-Box schweben beziehungslos untereinander.
* **Status-Kommunikation:** Wenn die Praxis erst am 01.11.2026 öffnet, irritiert der primäre Button „Online-Termin vereinbaren“ vs. „Hausbesuche bieten wir weiterhin an“. Aktuell sind Hausbesuche das Hauptangebot bis zur Eröffnung!

#### 5) Vertrauenssignale für ältere Patienten
* **Telefonnummer fehlt oben:** Ältere Patienten buchen ungern anonym online. Die Telefonnummer gehört groß und direkt klickbar in den Header (nicht erst in den Footer mit „Nummer kopieren“).
* **Inhaberin zu weit unten:** Frau Kiehnes sympathisches Porträt und der tolle Empfangsbereich (Holzlamellen) schaffen sofort Vertrauen – sie gehören in den sichtbaren Startbereich.
* **Fehlende Praxis-Infos:** Hinweise wie „Barrierefreier Zugang?“ oder „Parkplätze vor der Tür“ fehlen.

#### 6) Mobil (iPhone)
* Es fehlt ein Hamburger-Menü (Navigation verschwindet komplett).
* Nach den Buttons schneidet das Bild nur die oberen Hausfenster an – null Informationswert beim ersten Scrollen.

---

#### 7) Top-5-Maßnahmen (Priorisiert)

1. **Logo freistellen & Header aufwerten**
   * *Problem:* Weiße Kachel ums Logo wirkt billig; Telefonkontakt fehlt.
   * *Lösung:* Logo als transparentes SVG auf reinweißem Header (`#FFFFFF`) einbinden. Rechts neben die Navigation direkt die Telefonnummer als klaren Link (`📞 0160 96210972`) vor den CTA-Button setzen.
2. **Typografie an Wortmarke anpassen**
   * *Problem:* Serifenschrift beißt sich mit dem Logo.
   * *Lösung:* Wechsel auf eine freundliche, gut lesbare Sans-Serif für Headlines & Fließtext, z. B. **Plus Jakarta Sans** oder **Outfit** (Headlines SemiBold, Fließtext Regular, mind. `18px` Grundgröße). Kursivschrift im H1 streichen, stattdessen Highlight-Worte in Petrol (`#1B998B`) setzen.
3. **Farbwelt aus Praxis-Holz & Logo-Verlauf aufbauen (Dark Mode abschalten)**
   * *Problem:* Kühles Eisblau wirkt steril; Dark Mode fremdelt.
   * *Lösung:* Nur Light Mode anbieten. Sektionshintergründe in warmem Sand/Creme (`#FAF7F2` – greift die Eiche der Praxis auf) statt Kaltgrau (`#F4F7FB`). Cards in Reinweiß (`#FFFFFF`), Akzent-Badges in sanftem Salbei (`#EBF5EE`, Text `#2E6F48`).
4. **Hero-Bild & Eröffnungskarte verschmelzen**
   * *Problem:* Außenfoto und Datums-Box stehen unverbunden untereinander.
   * *Lösung:* Als Hauptbild im Hero den warmen **Empfangsbereich mit Holzlamellen oder Frau Kiehne im Behandlungsraum** zeigen (Außenansicht klein zur Adresse/Anfahrt im Footer). Die „Praxiseröffnung ab 01.11.2026“-Info als kompaktes, überlappendes Badge (mit grünem Plus-Icon aus dem Logo) direkt am unteren Bildrand andocken.
5. **Seniorengerechte CTAs & Fokus bis November 2026 schärfen**
   * *Problem:* Unklare Buchbarkeit vor Eröffnung; kleine Klickflächen.
   * *Lösung:* Primär-CTA klar benennen („Termin / Hausbesuch anfragen“) und Sekundär-CTA direkt als Anruf-Button („Jetzt anrufen: 0160 96210972“) gestalten.

---

### xAI Grok 4.7 (`x-ai/grok-4.7`)

Kurz: Die Inhalte tragen, die Oberfläche nicht. Drei Systeme stehen nebeneinander statt eines.

**1) Markenkohärenz**
Die Kritik trifft. Logo: geometrische Sans, Königsblau–Türkis, grünes Plus. Praxis: Weiß, helle Eiche, warmes Licht, rosa Fassade. Entwurf: kühles Graublau, Serife; im Dark Mode eine weiße Logo-Kachel auf Nachtblau. Diese Kachel ist der Aufkleber, dunkel am deutlichsten. Die Fassadenfarbe nicht ins System holen – Foto rahmen, nicht mitfärben. Türkis und Plus-Grün haben in der UI fast keinen Job.

**2) Typografie**
Die Wortmarke ist eine geometrische Grotesk. Überschriften sind eine Serife, „in der Praxis“ eine blaue Serifen-Kursive. Das ist der Fremdkörper, nicht die Schriftgröße. Akzent nur über Farbe und Schnitt, nicht über eine zweite Familie.

**3) Farbe**
Der Hintergrund ist kälter als Eiche und Putz. Fließtext ist Grau auf Graublau – zu wenig Kontrast für die Zielgruppe. Das Button-Blau ist heller und gesättigter als das Königsblau der Wortmarke; Logo und Button wirken deshalb nicht verwandt.

**4) Layout und Hierarchie**
Behalten: Leistungskarten, Zeiten, Porträt, Räume mit Unterschrift (Hygiene ist ein starkes Signal), Qualifikations-Pills, Hausbesuchsorte. Im Hero nicht: Foto und Karte „Neu 1.11.2026“ haben Abstand, eigenen Schatten, keine gemeinsame Kante – zwei Objekte. „Nummer kopieren“ ist ein Software-Muster, kein Praxis-Muster.

**5) Vertrauen**
Richtig vorhanden: Name, staatliche Anerkennung, Heilpraktikerin, Verband, echte Fotos, Telefon, Adresse, klare Zeiten. Zu leise für ältere Patienten: kein Telefon im Kopf, Online-Buchung als einziger lauter Weg, Datum als Ziffern, blasser Zweitbutton, Entwurfsbanner. Diese Gruppe ruft an. Erreichbarkeit (Ebene, Stufe, Parken) ergänzen, sobald sie feststeht – nicht erfinden.

**6) Mobil**
Buttons in voller Breite sind richtig. Auf 390px fehlt im Header ein Menü: Leistungen, Hausbesuche, Über uns, Kontakt sind im Screenshot nicht erreichbar. Die Tagline in der Logo-Kachel wird unlesbar. Tablet hält das Raster; der Bruch ist das Phone. Dark Mode nicht als Standard.

**7) Top 5**
1. Serife gegen Wortmarke. → Eine Sans: Überschriften Outfit oder Sora; Fließtext Atkinson Hyperlegible, 18px, Zeilenhöhe 1,6. „in der Praxis“ dieselbe Sans, nur in #1A9A8C.
2. Logo aufgeklebt, Markenfarben ungenutzt. → Nur das Fuß-Icon, ohne weiße Kachel; Name daneben in der Seitenschrift. Buttons und Überschriften #1B4F9C, Akzent #1A9A8C, „Neu“ #2E9E48. Grund #F6F3EE, Text #1C2430, Fließtext #2F3B4A. Werte angelehnt an Logo und Eiche.
3. Foto und Eröffnungskarte getrennt. → Eine Karte: Bild oben, Text bündig darunter, ein Schatten, Linie #C4A574. „ab 1. November 2026“.
4. Anrufen ist der zweite Weg und sieht aus wie der letzte. → Im Header „Anrufen · 0160 96210972“ als tel:-Link, gleich neben „Termin buchen“. Zweitbutton mit 2px-Rand #1B4F9C, nicht als blasser Umriss. Kopier-Buttons streichen. Entwurfszeile vor dem Launch entfernen.
5. Mobile ohne Navigation. → Sichtbares Menü-Icon, Ziele als Liste, Zeilen mindestens 48px. Light Mode als Standard; Dark Mode nur optional, Icon dann ohne weiße Kachel.

---

## Konsolidierte Befunde und Maßnahmen

Übereinstimmung aller vier Kritiken (3 Modelle + Claude) ist bei den ersten fünf Punkten vollständig.

| # | Problem (Version 1) | Wer nennt es | Maßnahme (umgesetzt in Version 2) |
|---|---|---|---|
| 1 | Logo in weißer Kachel auf getöntem Kopf, im Dark Mode extrem → „aufgeklebt“ | alle | Freigestelltes Logo direkt auf reinweißem Kopf, größer (70 px Desktop, 54 px mobil), keine Kachel. **Seite bewusst nur hell** (`color-scheme: light`, kein Dark Mode), da die dunkelblaue Wortmarke auf Dunkel ohne eigene Logo-Variante nicht funktioniert. |
| 2 | Serife Fraunces + Kursiv widerspricht geometrischer Wortmarke | alle | Überschriften **Outfit** (geometrische Grotesk, nah an der Wortmarke, freundlicher als eckige Tech-Schriften), Fließtext **Atkinson Hyperlegible Next** (für Sehschwäche entwickelt), Grundgröße **18 px**, Zeilenhöhe 1,65. Akzent im H1 nur über Logo-Blau, keine Kursive. Telefonnummern/Zeiten in Outfit (Atkinson hat eine durchgestrichene Null). |
| 3 | Farbreste (`--sage`/`--peach`), kühles Graublau, Türkis fehlt | alle | Palette aus dem Logo: Königsblau #2356A5 (Buttons, Akzent), Türkis-Text #0E6B64, Grün #6AB973 nur dekorativ (Plus-Zeichen vor jeder Rubrik wie im Logo), Verlauf Blau→Petrol als Kontaktband. Neutrale aus der Praxis: warmes Weiß #FAF7F2, Eiche hell #F1E8DA, Linien #DCD1C0. Lila Fassade nur als Foto. |
| 4 | Hero-Foto und „Neu 1.11.2026“-Karte unverbunden | alle | Originalfoto (Hochformat, ganzes Haus mit Schild „PODOLOGIE“ und Nr. 68) groß im Hero; Eröffnungsinfo als fest angedocktes Band im Markenverlauf am unteren Bildrand mit Adresse und Route. |
| 5 | Telefon versteckt, „Nummer kopieren“, Online-Buchung als einziger lauter Weg | alle | Telefon im Kopf (tel:-Link, mobil als Icon-Button), als zweiter Hero-Button, groß im Kontaktband mit „Jetzt anrufen“. Ein einheitlicher Primär-CTA „Termin vereinbaren“. Kopier-Buttons entfernt, mailto-/tel-Links. Online-Buchung klar als „Vorschau“ markiert. |
| 6 | Mobil ohne Navigation, Foto erst nach 2 Bildschirmen | GPT, Gemini, Grok, Claude | Menü-Button (`details`, ohne JS-Abhängigkeit, 48 px Ziele); Leistungskarten mobil kompakt (Icon links); Vertrauensüberschrift vor dem Foto. |
| 7 | „Öffnet am 1.11.“ – Praxis ist seit 01.11.2026 offen | Gemini, Claude | „Neu eröffnet – seit 1. November 2026“. |
| 8 | Vertrauenssignale als kleine graue Pills versteckt | alle | Eigener Abschnitt „Sicher in guten Händen“: staatlich anerkannt, Heilpraktikerin, Bundesverband, Hygiene – mit großem Hygieneraum-Foto. |
| 9 | Porträt als 180-px-Kreis wirkt wie App-Avatar | Gemini, Claude | Großes Porträt mit Eichen-Hinterlegung, Zitat in Ich-Form, Namenszeile; darunter Empfang und Behandlungsraum. |
| 10 | Zeiten/Hausbesuche nüchtern, Tabelle ohne Zeilenköpfe | Claude | Zwei Panels: Sprechzeiten (`th scope=row`, Praxistage blau, Hausbesuchstag türkis) und Hausbesuchsgebiet mit Orts-Pins. |
| 11 | Impressum/Datenschutz zeigen ins Leere | Claude | Platzhalter-Absätze mit Ankern im Fuß. |
| 12 | Barrierefreiheit (Zugang, Parken) fehlt | GPT, Gemini, Grok | **Nicht umgesetzt** – Angaben liegen nicht vor, nicht erfinden. Bei der Kundin erfragen (Stufe am Eingang? Parkplätze?) und dann im Kontaktband ergänzen. |

Weitere Qualität: Kontraste geprüft (alle Text-/Hintergrundpaare ≥ 5,5:1, Fließtext 7,6:1), sichtbarer Fokus (3 px Rahmen, auf dem Verlauf weiß), Skip-Link, kein horizontaler Scroll bei 1440/1024/390 px, externe Anfragen nur Google Fonts.

**Offene Fragen an die Kundin:** Barrierefreiheit/Parken; ob das Zitat und die Texte in Ich-Form so passen (Textvorschläge, bitte prüfen); Inhalt von Impressum/Datenschutz; Termin der PodoHero-Online-Buchung.

---

## Zweitmeinung zu Version 2 (`openai/gpt-5.6-sol`)

**Ja, die Seite wirkt inzwischen weitgehend wie eine Marke:** Logo-Farben, warme Praxisatmosphäre, Typografie, Bildsprache und der blau-türkise Kontaktbereich greifen sichtbar ineinander.

1. **Zu kleine Schrift auf Mobilgeräten**  
   **Ort:** Leistungskarten, Qualifikationen, Bildunterschriften, Öffnungszeiten und Footer. Vieles wirkt deutlich kleiner als die vorgesehenen 18 px und ist für ältere Menschen anstrengend.  
   **Lösung:** Fließtext mobil konsequent auf mindestens 18 px/1,5 setzen; Zusatztexte und Captions nicht unter 15–16 px.

2. **Logo im Kopf verliert seine Wirkung**  
   **Ort:** Desktop- und besonders Mobile-Header. Wortmarke und Unterzeile sind so klein, dass sie kaum lesbar sind; damit fehlt oben ein klarer Markenanker.  
   **Lösung:** Headerhöhe leicht erhöhen, Logo deutlich größer darstellen; mobil eine vereinfachte Wortmarke ohne Unterzeile verwenden.

3. **CTA verspricht mehr als aktuell verfügbar ist**  
   **Ort:** „Termin vereinbaren“ im Header und Hero. Der Button klingt nach direkter Buchung, führt aber offenbar nur zum Kontaktbereich; gleichzeitig wird unten die künftige Online-Buchung angekündigt.  
   **Lösung:** Bis zur Freischaltung „Termin anfragen“ verwenden und primär direkt den Telefonanruf auslösen bzw. Telefon und E-Mail als Auswahl zeigen.

4. **Mobile Seite ist zu lang und repetitiv**  
   **Ort:** Sechs einzelne Leistungskarten sowie Qualifikations-, Praxis- und Kontaktblöcke untereinander. Die zentralen Informationen liegen sehr weit auseinander.  
   **Lösung:** Leistungen mobil kompakter gestalten: kurze Einzeiler, zwei Kernleistungen offen, weitere über „Alle Leistungen anzeigen“. Kontaktinformationen ebenfalls stärker bündeln.

5. **Kontrast und visuelle Gewichtung sind teilweise zu schwach**  
   **Ort:** Grüne Abschnittslabels, graue Beschreibungstexte, Bildunterschriften sowie Konturen der Karten auf warmem Hintergrund. Diese Elemente wirken blass.  
   **Lösung:** Text- und Grünwerte abdunkeln und alle Kombinationen nach WCAG AA prüfen; Karten entweder klarer abgrenzen oder bewusst ohne kaum sichtbare Rahmen gestalten.

**Einordnung (Claude):**
- Punkt 1 (Schrift mobil zu klein) trifft nicht zu – das Modell sah eine stark verkleinerte Ganzseiten-Aufnahme; gemessen sind Fließtext 18 px, Zusatztexte/Captions 16–17 px.
- Punkt 2 (Logo) → umgesetzt: Logo mobil von 46 auf 54 px vergrößert. Eine vereinfachte Wortmarke ohne Unterzeile wäre ein Logo-Eingriff – nur mit der Kundin.
- Punkt 3 (CTA) → bewusst beibehalten: „Termin vereinbaren“ führt zum Kontaktband, in dem das Telefon an erster Stelle steht. Das stimmt, auch ohne Online-Buchung.
- Punkt 4 (mobile Länge) → teilweise umgesetzt (kompakte Leistungskarten). Ein Auf-/Zuklappen der Leistungen ist für ältere Nutzer eher eine Hürde.
- Punkt 5 (Kontrast) → gemessen AA-konform; Kartenränder etwas dunkler gesetzt (#DCD1C0).

Screenshots Version 2: `/tmp/claude-0/-home-user/6fc999be-db49-589e-bd58-917b40523ab0/scratchpad/kiehne-v2-*.png` (Desktop, iPad, iPhone; „d-dark“ belegt, dass die Seite auch bei dunklem Systemmodus hell bleibt).
