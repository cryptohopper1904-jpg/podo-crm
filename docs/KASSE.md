# Kasse, Tagesabschluss (Z-Bon) und DSFinV-K

> **Wichtig:** Diese Seite beschreibt, was PodoCRM technisch macht. Sie ist **keine Steuerberatung**. Ob und wie eure
> Praxis eine Kasse im Sinne der KassenSichV betreibt, welche Meldungen nötig sind und ob die Daten so für eine
> Betriebsprüfung reichen, bitte **mit der Steuerberatung abstimmen**.

## 1. Was die Praxis tun muss (Stand Ende 2026, bitte prüfen lassen)

| Pflicht | Worum es geht | Wer |
|---|---|---|
| **TSE bei elektronischem Aufzeichnungssystem** (§ 146a AO, KassenSichV) | Wer Bargeschäfte mit einem elektronischen Aufzeichnungssystem (z. B. Kassen-Software, Rechnungsprogramm mit Kassenfunktion) erfasst, muss **jeden aufgezeichneten Geschäftsvorfall** über eine **zertifizierte technische Sicherheitseinrichtung (TSE)** absichern – nicht nur die Barzahlung, sondern auch Karten- und Gutscheinzahlungen, die das System erfasst. Ob PodoCRM in eurer Nutzung ein solches System ist, hängt davon ab, wie Zahlungen erfasst werden – nach unserem Verständnis ist das bei Erfassung von Barzahlungen in PodoCRM regelmäßig der Fall. PodoCRM signiert deshalb **alle Kassenvorgänge (Bar, Karte, Gutschein)**; Überweisung und Zahlungslink sind keine Kassenvorgänge. | Praxis (Vertrag mit TSE-Anbieter, z. B. fiskaly), PodoCRM (Anbindung) |
| **Meldung an das Finanzamt** (§ 146a Abs. 4 AO) | Elektronische Aufzeichnungssysteme und TSE sind dem Finanzamt zu melden. Seit **1. Januar 2025** geht das über **„Mein ELSTER“** bzw. die ERiC-Schnittstelle (Formular „Mitteilung über elektronische Aufzeichnungssysteme“). Neue Systeme innerhalb eines Monats nach Anschaffung, Außerbetriebnahme ebenfalls innerhalb eines Monats – Fristen bitte mit der Steuerberatung klären. | Praxis bzw. Steuerberatung |
| **Belegausgabepflicht** (§ 146a Abs. 2 AO) | Bei jedem Vorgang im elektronischen Aufzeichnungssystem ist ein Beleg anzubieten (Papier oder elektronisch). Er muss u. a. TSE-Transaktionsnummer, Start/Ende, Signatur und Seriennummer der TSE enthalten. PodoCRM druckt Rechnungen/Quittungen; die TSE-Pflichtangaben auf dem Beleg sind **noch nicht vollständig** (siehe offene Punkte). Eine Befreiung ist nur auf Antrag möglich. | Praxis, PodoCRM |
| **Tagesabschluss / Kassenbuch** (GoBD, § 146 Abs. 1 AO) | Bareinnahmen und -ausgaben täglich aufzeichnen; Kassensturzfähigkeit; Zählprotokoll empfohlen. Einlagen/Entnahmen mit Grund. | Praxis (in PodoCRM: „Kasse“) |
| **Verfahrensdokumentation** (GoBD) | Beschreibung, wie Kasse, Rechnungen, Zahlungen und Abschlüsse in der Praxis ablaufen (inkl. Rollen, Rechte, Datensicherung). | Praxis (Vorlage folgt) |
| **Aufbewahrung** (§ 147 AO) | Abschlüsse, Einzelaufzeichnungen und TSE-Exporte i. d. R. 8 bzw. 10 Jahre. Daten bleiben in PodoCRM unveränderbar gespeichert; vor einer Kündigung den DSFinV-K-Export und den TSE-Export sichern. | Praxis |
| **Kassen-Nachschau / Prüfung** (§ 146b AO) | Auf Verlangen DSFinV-K-Export und TSE-Export (TAR) bereitstellen. | Praxis (Export unter „Kasse → DSFinV-K-Export“) |

**Ohne TSE**: Ein Abschluss ohne TSE wird in PodoCRM ausdrücklich als
„ohne TSE – nur zulässig, wenn keine elektronische Kasse im Sinne der KassenSichV“ gekennzeichnet. Das ist ein Hinweis,
keine Freigabe – ob das auf eure Praxis zutrifft, klärt bitte die Steuerberatung.

## 2. Was PodoCRM macht

- **Rechte** (eigene Kassen-Rechte, nicht mehr die Rechnungsrechte): *Kasse ansehen* (`cash.read`: Inhaber:in,
  Podolog:in, Empfang, Steuerberatung), *Kasse buchen/abschließen* (`cash.write`: Inhaber:in, Podolog:in, Empfang),
  *DSFinV-K-Export* (`cash.export`: nur Inhaber:in und Steuerberatung; im Support-Modus nie).
- **TSE-Signatur je Kassenvorgang**: Bar-, Karten- (auch SumUp-Terminal per Webhook) und Gutscheinzahlungen werden beim
  Buchen über die TSE signiert; Signatur, Seriennummer, Transaktionsnummer, Signaturzähler, Start und Ende stehen
  unveränderbar in `fiscal_transactions` (append-only) und gehen in `transactions_tse.csv`. Fällt die TSE bei einer
  Terminal-Zahlung aus, wird die Zahlung trotzdem gebucht und der Ausfall im Posteingang gemeldet (dokumentieren).
- **Kasse (`/kasse`)** – Ansicht mit *Kasse ansehen*, Abschluss und Kassenbuch mit *Kasse buchen*.
  - Offene Einnahmen je Zahlart (Bar, Karte, Überweisung, Gutschein, Zahlungslink) seit dem letzten Abschluss.
  - Kassenbuch: Einlagen/Entnahmen (Privateinlage/-entnahme, Geldtransit, Auszahlung, Einzahlung) mit Pflicht-Grund.
    Einträge sind unveränderbar; Korrektur nur per Gegenbuchung; nicht rückdatierbar (vor den letzten Abschluss) und
    nicht in der Zukunft. Freitexte (Grund, Differenzbegründung, Notiz) dürfen nicht mit `=`, `+`, `-`, `@` beginnen
    (Schutz vor Formeln beim Öffnen des Exports in Excel) und sollen keine Namen/Gesundheitsdaten enthalten.
  - Zählprotokoll (Scheine/Münzen), Soll-/Ist-Vergleich, Differenz mit Pflicht-Begründung.
  - Anfangsbestand: beim ersten Abschluss eingeben, danach automatisch der gezählte Bestand des Vorabschlusses.
- **Tagesabschluss (Z-Bon)**
  - Umfasst alle bis zum Stichzeitpunkt nicht abgeschlossenen Zahlungen und Kassenbuch-Einträge (auch vergessene
    Vortage). Verspätet eingehende Zahlungen (z. B. Kartenzahlung per Webhook nach dem Abschluss) landen im nächsten Abschluss.
  - Je Praxis **lückenlos nummeriert** (Advisory-Lock in der Anwendung, zusätzlich prüft ein DB-Trigger Nummer,
    Hash-Kette und Datumsreihenfolge), **append-only** (kein UPDATE/DELETE/TRUNCATE) und per **SHA-256-Hash-Kette**
    verbunden (wie die Behandlungsdoku). Zusätzlich eine Prüfsumme über die enthaltenen Zahlungen/Bewegungen und ein
    **unveränderlicher Snapshot aller Bons** (Positionen, USt-Aufteilung, Gutscheine, TSE-Daten) als Teil der Hash-Kette –
    Z-Bon und DSFinV-K-Export lesen nur daraus; spätere Änderungen an Rechnungen/Gutscheinen wirken nicht zurück.
    Abschluss, Zuordnung der Zahlungen und Audit-Eintrag sind eine Transaktion.
  - Summen je Zahlart, je Steuersatz (brutto/netto/USt) und je DSFinV-K-Geschäftsvorfall, fortlaufende Belegnummern.
  - TSE: mit fiskaly (`TSE_PROVIDER=fiskaly`) wird der Abschluss **nach dem Speichern** an den DSFinV-K-Dienst gemeldet
    (idempotent über die Abschluss-ID, Ergebnis in `cash_closing_registrations`, Referenz im Z-Bon). Schlägt die Meldung
    fehl, bleibt der Abschluss bestehen und zeigt „Meldung ausstehend“ mit dem Knopf **„Meldung wiederholen“** – es
    entsteht nie eine TSE-Meldung ohne Z-Bon. Ohne TSE: Kennzeichnung „ohne TSE …“, Test-Signaturen werden ausgewiesen.
  - Ansicht/Druck unter `/kasse/abschluss/<id>`, PDF unter `/api/kasse/z-bon/<id>`.
- **Sperre abgeschlossener Zeiträume**: Zahlungen mit Z-Bon-Zuordnung, mit `paid_at` bis zum Stichzeitpunkt eines
  Abschlusses oder an/vor einem abgeschlossenen Buchungstag (Europe/Berlin) können weder geändert noch gelöscht werden
  (DB-Trigger `payments_closing_guard`, serverseitig `assertPaymentsEditable`). Einzige erlaubte Änderung: die einmalige
  Zuordnung zum Abschluss. Neue Zahlungen von Benutzer:innen können nicht rückwirkend in einen abgeschlossenen Zeitraum
  datiert werden; verspätete Terminal-/Webhook-Zahlungen (ohne Benutzer) gehen in den nächsten Abschluss.
- **Übernommene Altzahlungen** (Excel-Import, `payments.external_ref` beginnt mit `excel:`) kommen **nie** in einen
  Abschluss – sie stehen im Kassenbuch des bisherigen Systems (Migration 0060, Filter in `loadItems`). Maßgeblich ist die
  Herkunft der **Zahlung**: Ein Neueingang in PodoHero auf eine übernommene Altrechnung kommt normal in Kasse und Z-Bon
  und wird in der Buchhaltung manuell gegen die alte Forderung ausgebucht. Manuelle Referenzen mit `excel:` lehnt die App ab.
- **DSFinV-K-Export (`/kasse/export`)**: ZIP für einen Zeitraum mit `index.xml` und den Tabellen
  `cashpointclosing.csv`, `location.csv`, `cashregister.csv`, `vat.csv`, `tse.csv`, `businesscases.csv`,
  `payment.csv`, `cash_per_currency.csv`, `transactions.csv`, `transactions_vat.csv`, `datapayment.csv`, `lines.csv`,
  `lines_vat.csv`, `transactions_tse.csv`, `references.csv`. UTF-8, Semikolon, Dezimalkomma, Text in `"…"`, CRLF,
  Kopfzeile. Ein Kassenabschluss = ein Z-Bon; Bons = Zahlungen an der Kasse (Bar, Karte, Gutschein) und
  Kassenbuch-Einträge; Rechnungsnummer als Referenz („ExterneRechnung“). Keine Patientendaten im Export. Vor dem Export
  wird die gesamte Hash-Kette (Z-Nummern, Inhalt, Belegnummern) geprüft; bei einem Bruch bricht der Export ab.
- **Prüfung im Betrieb**: `scripts/verify-hash-chains.ts` und `deploy/restore-test.sh` prüfen auch die Kette der
  Kassenabschlüsse und lückenlose Z-Nummern je Praxis.

## 2a. Eigene Praxiskasse (Praxis hat ein eigenes zertifiziertes Kassensystem mit TSE)

Hat die Praxis bereits eine eigene, zertifizierte Kasse mit TSE, kann die Inhaber:in unter **Kasse → „Eigene
Praxiskasse verwenden“** umschalten (Recht `settings.manage`). Pflichtangabe „Kassensystem / Grund“ (z. B. Hersteller,
Modell und TSE-Seriennummer der Praxiskasse, 3–200 Zeichen) und eine Bestätigung; das Umschalten wird mit
`{from, to, offenePosten, reason}` protokolliert (Audit `kasse.external_register`).

**Voraussetzung zum Umschalten (beide Richtungen):** keine offenen PodoHero-Kassenvorgänge – also keine Bar-, Karten-
oder Gutscheinzahlung der PodoHero-Kasse ohne Tagesabschluss und keine offene Einlage/Entnahme. Sonst: „Bitte zuerst den
Tagesabschluss machen.“ Kamen nach dem heutigen Tagesabschluss noch PodoHero-Kassenzahlungen dazu, ist heute kein
weiterer Abschluss möglich – dann erst **am nächsten Tag** nach dessen Tagesabschluss umschalten. Im Support-Modus ist
das Umschalten gesperrt. Die Prüfung läuft in derselben Transaktion unter dem Kassen-Lock; Buchungen lesen die Einstellung
gesperrt (`FOR SHARE`), sodass nie eine PodoHero-Zahlung „zwischen“ Prüfung und Umschalten entsteht.

**Was dann passiert:**

- Bar-, Karten- und Gutscheinzahlungen werden an der Rechnung **nur vermerkt**: ohne PodoHero-TSE-Signatur, ohne
  Zahlungsbeleg (kein ZB-Nummernkreis), ohne PodoHero-Kassenbuch, Tagesabschluss und DSFinV-K. Jede Zahlung trägt dafür
  die unveränderliche Kennzeichnung `payments.register = 'external'` (Migration 0063, vom Server gesetzt, per Trigger
  unveränderlich). **Maßgeblich ist diese Kennzeichnung, nicht die aktuelle Einstellung**: Schaltet die Praxis später
  zurück, kommen frühere Vermerke trotzdem nie in einen PodoHero-Z-Bon und gelten nie als „Beleg fehlt“; PodoHero-Zahlungen
  von vorher behalten umgekehrt ihren Zahlungsbeleg bzw. den Hinweis „Beleg fehlt“. Überweisung und Zahlungslink sind
  keine Kassenvorgänge und bleiben unverändert.
- Beim Erfassen gibt es das Feld **„Bon-Nr. Praxiskasse“** (optional, max. 40 Zeichen, nur Buchstaben, Ziffern, `-`
  und `/`). Gespeichert als `external_ref = 'praxiskasse:<Nr>'` – das Präfix setzt nur der Server.
- Rechnungs-PDF, Quittung („bar beim Ausstellen“) und Rechnungsansicht tragen statt der TSE-Angaben den Vermerk
  „Zahlung in der Praxiskasse erfasst (Bon-Nr. …). Den Kassenbeleg gibt die Praxiskasse aus.“
- Die Kasse-Seite zeigt keinen Kassenbestand, keine Einlagen/Entnahmen und keinen Tagesabschluss mehr, sondern die Liste
  **„Kassenvermerke“** (Datum, Rechnung, Zahlart, Betrag, Bon-Nr.) mit Tagessumme je Zahlart zum Abgleich mit dem Z-Bon
  der Praxiskasse, plus CSV-Download (Recht `cash.export`). Frühere PodoHero-Abschlüsse bleiben einsehbar und über
  `/kasse/export` exportierbar (Aufbewahrung).

**Arbeitsablauf am Tresen:**

1. **Erst die Praxiskasse:** Zahlung in der Praxiskasse buchen – als **„Zahlung auf Rechnung“ (Forderungsauflösung)**,
   nicht als neuer Umsatz, denn die Rechnung (mit USt-Ausweis) stellt PodoHero aus. Den Kassenbon der Praxiskasse
   aushändigen.
2. **Dann der Vermerk in PodoHero:** an der Rechnung „Zahlung erfassen“, Zahlart wie in der Praxiskasse, Bon-Nr. der
   Praxiskasse eintragen.
3. **Abends:** Z-Bon der Praxiskasse mit den Tagessummen unter „Kassenvermerke“ abgleichen.

**Zuzahlung zur Heilmittelverordnung (GKV, ab Paket B):** Die Zuzahlung (10 % + 10 € je Verordnung) wird an der
Verordnung als **Zuzahlungsquittung** (Beleg ZZ) erfasst – mit derselben Zahlungslogik wie jede Quittung: bei aktiver
eigener Praxiskasse als Vermerk mit Bon-Nr. (erst in der Praxiskasse als Zahlung auf Beleg buchen, dann hier vermerken),
sonst als PodoHero-Kassenvorgang mit TSE im nächsten Z-Bon. Kein USt-Ausweis (gesetzliche Zuzahlung, § 32 Abs. 2 /
§ 61 SGB V; Hinweis „Umsatzsteuerfrei nach § 4 Nr. 14 Buchst. a UStG“). Erstattung über „stornieren/erstatten“
(Stornobeleg mit negativer Zahlung). Frühere Vermerke „Zuzahlung erhalten“ (vor Paket B) waren nie in der Kasse und werden
nicht nachgebucht – Nacherfassung bitte mit der Steuerberatung klären.

**Gutscheine:** Den Verkauf (Geldeingang) erfasst nur die Praxiskasse. PodoHero vergibt Code und Wert. Die Einlösung
bucht die Praxiskasse als Zahlart Gutschein auf die PodoHero-Rechnung, PodoHero vermerkt sie (Restguthaben führt
PodoHero, kein Zahlungsbeleg).

**Erstattung und Storno:** Erst in der Praxiskasse als Auszahlung bzw. Storno „auf Rechnung“ mit Verweis auf den
Ursprungsbon buchen, dann in PodoHero an der Stornorechnung die Erstattung vermerken – mit der Bon-Nr. des Storno-Bons.
Das Kennzeichen der Erstattung folgt der Einstellung **zum Zeitpunkt der Erstattung**, nicht der ursprünglichen Zahlung:
- Zahlung lief über die Praxiskasse, inzwischen ist wieder die PodoHero-Kasse aktiv: Die Erstattung ist ein
  PodoHero-Kassenvorgang (TSE-signiert, im nächsten Z-Bon). In der Praxiskasse zusätzlich nur, wenn das Geld dort
  ausgezahlt wird – dann bitte vorher zurückschalten bzw. mit der Steuerberatung klären.
- Sonderfall: Zahlung lief über die PodoHero-Kasse, Erstattung nach dem Umschalten: Die Erstattung ist ein Vermerk der
  Praxiskasse (ohne PodoHero-TSE, nicht im PodoHero-Z-Bon) und muss in der Praxiskasse gebucht werden; der Ursprungsbon
  steht im PodoHero-Z-Bon bzw. Zahlungsbeleg (ZB-Nr. als Verweis angeben).

**Zurückschalten auf die PodoHero-Kasse:** Der Anfangsbestand des nächsten PodoHero-Abschlusses ist der zuletzt
gezählte PodoHero-Bestand. Weicht das Bargeld in der Schublade davon ab (Bargeld lief zwischenzeitlich über die
Praxiskasse), den Bestand vor der ersten Zahlung per **Einlage/Entnahme** im Kassenbuch abgleichen. Nach dem
Zurückschalten bleiben die Kassenvermerke unter „Frühere Kassenvermerke“ auf der Kasse-Seite abrufbar.

**SumUp:** Läuft eine Kartenzahlung über die PodoHero-SumUp-Anbindung (Terminal), bucht PodoHero sie als Vermerk
(`register = 'external'`, `external_ref` bleibt `sumup:…`) und legt für jeden Eingang eine Meldung im Posteingang an
(„Kartenzahlung … bitte in der Praxiskasse erfassen“). Rechnungsansicht und PDF zeigen dazu „Über SumUp eingegangen –
in der Praxiskasse zu erfassen.“ Die Zahlung muss zusätzlich in der Praxiskasse erfasst werden.

**Offene Fragen an die Steuerberatung:**

- **§ 146a AO:** Ist PodoHero im Modus „eigene Praxiskasse“ selbst ein elektronisches Aufzeichnungssystem (es erfasst
  Zahlart, Betrag und Zeitpunkt jeder Barzahlung)? Wenn ja, bräuchte auch PodoHero eine TSE und eine Meldung – oder
  genügt die Erfassung in der Praxiskasse, wenn PodoHero nur die Forderung ausbucht?
- **§ 14c UStG:** Weist die Praxiskasse beim Buchen „auf Rechnung“ ggf. erneut USt aus (Bon zusätzlich zur Rechnung)?
  Dann droht ein unberechtigter/doppelter Steuerausweis – Buchungsart in der Praxiskasse festlegen.
- **Gutscheine:** Ausgabe und Einlösung in zwei Systemen – Einzweck-/Mehrzweck-Behandlung und Nachweis abstimmen.
- **SumUp:** Kartenzahlung über PodoHero-SumUp und zusätzlich in der Praxiskasse – zählt die Praxiskasse sie als
  Umsatz oder nur als Zahlungseingang? Doppelerfassung im Kassenbuch vermeiden.
- **Umstellungszeitpunkt:** Wechsel nur nach einem Tagesabschluss – reicht das als Dokumentation, oder muss die
  PodoHero-Kasse (Mock-TSE) gesondert außer Betrieb genommen bzw. abgemeldet werden?
- **Meldung beim Zurückschalten (§ 146a Abs. 4 AO):** Muss die Wieder-Inbetriebnahme der PodoHero-Kasse (bzw. die
  Außerbetriebnahme der Praxiskasse) gemeldet werden?
- **Erstattung über zwei Systeme:** Zahlung in einem System, Erstattung im anderen (siehe „Erstattung und Storno“) –
  zulässig, und wie ist der Verweis auf den Ursprungsbon zu dokumentieren?
- **Einzweckgutschein und § 14c UStG:** Beim Einzweckgutschein entsteht die USt beim Verkauf – weist die Praxiskasse
  beim Verkauf und PodoHero auf der Rechnung bei der Einlösung erneut USt aus?
- **Doppelbuchung Lexoffice + Kassenexport:** Rechnungen gehen aus PodoHero nach Lexoffice, Kasseneinnahmen über den
  Export der Praxiskasse in die Buchhaltung – wie wird eine doppelte Erfassung der Zahlung vermieden?
- **Kleinbetragsrechnung (§ 33 UStDV):** Gilt der Bon der Praxiskasse zusammen mit der PodoHero-Rechnung als zwei
  Rechnungen über dieselbe Leistung? Reicht für Kleinbeträge der Bon allein?

## 3. Offene Punkte (mit Steuerberatung / TSE-Anbieter klären)

Im Code als `// TODO DSFinV-K prüfen` markiert:

1. **Abdeckung der TSE** – *umgesetzt (Phase 5)*: Nach KassenSichV ist jeder vom elektronischen System aufgezeichnete
   Geschäftsvorfall abzusichern. PodoCRM signiert **Bar, Karte (auch SumUp-Terminal) und Gutschein**; Überweisung und
   Zahlungslink gelten nicht als Kassenvorgang (keine Signatur, nur Summe im Z-Bon) – bitte mit der Steuerberatung
   bestätigen. Vorgangsart derzeit einheitlich `Kassenbeleg-V1`; ob Gutschein-Einlösungen eine andere Vorgangsart
   brauchen, mit dem TSE-Anbieter klären.
2. **TSE-Daten je Transaktion**: Signatur, Start/Ende, Seriennummer, Transaktionsnummer und Signaturzähler werden seit
   Phase 5 vollständig gespeichert (`fiscal_transactions`) und exportiert. Offen: Prozessdaten (`TSE_VORGANGSDATEN`)
   im Format des Anbieters; Altbestand (vor Migration 0016) hat nur die Kurzreferenz aus `payments.external_ref`.
3. **`tse.csv`**: Signaturalgorithmus, Zeitformat, Encoding, Public Key und Zertifikate vom Anbieter übernehmen.
4. **fiskaly-Kassenabschluss**: Die Meldung (`PUT /cash_point_closings/{id}`) sendet nur Kopf und Summen; fiskaly
   erwartet zusätzlich alle Einzeltransaktionen und eine fortlaufende Export-ID. Gegen die fiskaly-Doku vervollständigen.
5. **USt-Schlüssel**: 0 % wird als Schlüssel 6 („umsatzsteuerfrei“) gemeldet – passt für § 4 Nr. 14 UStG; für
   **Kleinunternehmer (§ 19 UStG)** ggf. anderer Schlüssel.
6. **Gutscheine**: Mehrzweck-Einlösung als negative Position `MehrzweckgutscheinEinloesung` (Schlüssel 5),
   Einzweck-Einlösung mit gespiegeltem Steuersatz; Gutscheinverkauf als `Mehrzweck-/EinzweckgutscheinKauf`.
7. **Rechnungen auf Ziel**: Zahlung an der Kasse für eine früher ausgestellte Rechnung wird als `Umsatz` gemeldet.
   Ggf. `Forderungsentstehung`/`Forderungsaufloesung` (Soll-/Ist-Versteuerung) verwenden.
8. **Überweisung/Zahlungslink** sind **nicht** in der Einzelaufzeichnung (keine Kassenvorgänge), stehen aber im Z-Bon.
9. **Kartenzahlung**: `ZAHLART_TYP` „Unbar“ – genauer Typ (ECKarte/Kreditkarte/ElZahlungsdienstleister) ist bei SumUp nicht bekannt.
10. **Anfangsbestand**: nur beim ersten Abschluss als `Anfangsbestand`-Vorgang; danach Übertrag des gezählten Bestands.
11. **Formalia**: Zeitstempel als Ortszeit ohne Offset; Feldlängen/Nachkommastellen, Tabellennamen in `index.xml`,
    `TAXONOMIE_VERSION` (2.3 vs. 2.4), Kodierung der Kennzeichen (0/1), `AGENTUR_ID` 0, fehlende `<ForeignKey>`-Angaben.
    Die DTD `gdpdu-01-09-2004.dtd` wird nur referenziert und muss bei Weitergabe beigelegt werden (BMF-Download).
12. **Kundendaten im Bonkopf** (`KUNDE_*`): bewusst leer (Gesundheitsdaten-Bezug) – prüfen, ob/ab wann Angaben nötig sind.
13. **Belegausgabe**: TSE-Pflichtangaben (u. a. QR-Code nach DSFinV-K Anhang) auf Quittung/Rechnung ergänzen.
14. **Kassen-Stammdaten**: Kassen-ID/Seriennummer aus `organizations.settings.kasse` (`kasseId`, `serial`), sonst
    automatisch `PODOCRM-<praxis>`. Muss zur Meldung über ELSTER passen.
15. **Zuzahlungsquittung (GKV)**: Annahme – die Zuzahlung ist Teil des Entgelts für die steuerfreie Heilbehandlung
    (§ 4 Nr. 14 Buchst. a UStG) und wird daher als Bon „Umsatz“ mit USt-Schlüssel 6 („steuerfrei“) gemeldet. Ob ein
    eigener Geschäftsvorfall nötig ist, mit Steuerberatung/TSE-Anbieter bestätigen.
    Zuzahlungsquittungen (Belege ZZ) gehen **entweder** über lexoffice **oder** über den Kassenexport (DSFinV-K/Z-Bon) an
    die Buchhaltung, nicht beides (sonst doppelt erfasst). Die Auszahlung des Abrechnungszentrums enthält die Zuzahlung
    nicht und wird netto als Kassenanteil gebucht. Beides mit der Steuerberatung klären.
