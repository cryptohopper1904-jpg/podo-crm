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
  datiert werden; verspätete Terminal-/Webhook-Zahlungen (ohne Benutzer) und der Altdaten-Import gehen in den nächsten Abschluss.
- **DSFinV-K-Export (`/kasse/export`)**: ZIP für einen Zeitraum mit `index.xml` und den Tabellen
  `cashpointclosing.csv`, `location.csv`, `cashregister.csv`, `vat.csv`, `tse.csv`, `businesscases.csv`,
  `payment.csv`, `cash_per_currency.csv`, `transactions.csv`, `transactions_vat.csv`, `datapayment.csv`, `lines.csv`,
  `lines_vat.csv`, `transactions_tse.csv`, `references.csv`. UTF-8, Semikolon, Dezimalkomma, Text in `"…"`, CRLF,
  Kopfzeile. Ein Kassenabschluss = ein Z-Bon; Bons = Zahlungen an der Kasse (Bar, Karte, Gutschein) und
  Kassenbuch-Einträge; Rechnungsnummer als Referenz („ExterneRechnung“). Keine Patientendaten im Export. Vor dem Export
  wird die gesamte Hash-Kette (Z-Nummern, Inhalt, Belegnummern) geprüft; bei einem Bruch bricht der Export ab.
- **Prüfung im Betrieb**: `scripts/verify-hash-chains.ts` und `deploy/restore-test.sh` prüfen auch die Kette der
  Kassenabschlüsse und lückenlose Z-Nummern je Praxis.

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
