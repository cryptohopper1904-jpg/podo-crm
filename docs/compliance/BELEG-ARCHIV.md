# Beleg-Archiv und Zahlungsbelege – Baustein für die Verfahrensdokumentation (GoBD)

> Entwurf als Arbeitsgrundlage für die Verfahrensdokumentation der Praxis, **keine Steuerberatung**.

## Was beim Ausstellen passiert
- Rechnung, Quittung, Anzahlung, Sammelrechnung und Stornorechnung werden in einer Datenbank-Transaktion ausgestellt (Nummer, Beträge, Leistungsdatum, Momentaufnahme der Praxis- und Empfängerangaben in `invoices.issued_snapshot`). Danach sind diese Angaben per Trigger unveränderbar.
- Als letzter Schritt derselben Transaktion wird das PDF erzeugt und verschlüsselt abgelegt (`document_archive`: SHA-256, Größe, Dateiname). Download, E-Mail-Anhang und Patientenportal liefern genau diese Bytes aus.
- Spätere Zahlungen (bar, Karte, Gutschein; SumUp-Terminal) erhalten je Kassenvorgang einen eigenen „Beleg über Zahlungseingang“ (Nummernkreis ZB) mit TSE-Angaben; die Angaben werden mit der Zahlung festgeschrieben (`payment_receipts`), das PDF unmittelbar danach archiviert.

## Wenn die Ablage scheitert (Nachholen)
- Ein Ablagefehler (Speicher, Schlüssel, Erzeugung) macht den Beleg nicht ungültig und rollt keine TSE-signierte Zahlung zurück. Die Praxis erhält eine Meldung im Posteingang.
- Das PDF wird **aus den festgeschriebenen Angaben** nachgeholt: beim nächsten Abruf und im Hintergrundlauf (Cron, mit wachsender Wartezeit nach Fehlversuchen). Erst danach wird es ausgehändigt; bis dahin lehnen Download, E-Mail-Versand und Portal mit „PDF wird gerade erzeugt“ ab – es wird **keine unarchivierte Fassung** ausgegeben.
- Ein nachträglich (mehr als 10 Minuten nach dem Ausstellen bzw. der Zahlung) erzeugtes PDF trägt den Vermerk „PDF nachträglich erzeugt am …“ (mit Hinweis auf das zum Erzeugungszeitpunkt hinterlegte Logo); jedes erfolgreiche Nachholen wird in derselben Transaktion im Audit-Log protokolliert (mit angemeldeter Person, wenn das Nachholen durch einen Abruf ausgelöst wurde).
- Solange das PDF fehlt, druckt die Rechnungsseite den Beleg nicht aus der Bildschirmansicht, sondern nur über das archivierte PDF („Drucken (über PDF)“); der PDF-Link zeigt bis dahin eine Hinweisseite „PDF wird erzeugt“ und versucht es nach einer Minute erneut.

### Bekannte Abweichungen beim Nachholen
- **PDF-Programmcode:** Das nachgeholte PDF wird mit dem zum Zeitpunkt des Nachholens aktuellen Programmstand erzeugt (Layout kann sich gegenüber dem Ausstellungstag unterscheiden; Belegtexte und Beträge sind durch Tests festgehalten).
- **Logo:** Das Praxis-Logo wird nicht in der Momentaufnahme gespeichert (beim Austausch wird die alte Datei gelöscht). Ein nachgeholtes PDF zeigt das zum Erzeugungszeitpunkt hinterlegte Logo; alle übrigen Angaben (Praxis, Anschrift, Bankverbindung, Steuernummer, Empfänger, Zahlungen beim Ausstellen, Anrechnungen) stammen aus den festgeschriebenen Daten.

## Zahlungsbeleg fehlt
- Kann die Zeile des Zahlungsbelegs bei der Buchung nicht angelegt werden, bleibt die Zahlung gebucht (samt TSE-Signatur, sofern die TSE erreichbar war); „Zahlung erfassen“ zeigt eine deutliche Warnung, und auf der Rechnungsseite erscheint „Zahlungsbeleg fehlt“.
- Mit dem Recht „Rechnungen bearbeiten“ kann der Zahlungsbeleg dort gezielt **nachträglich erstellt** werden – je Zahlung höchstens einmal. Welche Zahlungen dafür in Frage kommen, prüft der Server bei jedem Aufruf selbst (dieselbe Regel wie die Anzeige): Kassenzahlungen (bar, Karte, Gutschein) nach Ausstellung der Rechnung, auf in PodoHero ausgestellten Belegen, bezahlt ab dem Stichtag der Einführung der Zahlungsbelege (Migration 0049, 14.11.2026). Eine automatische Massennachholung für Altzahlungen gibt es bewusst nicht.
- Zahlungen mit **TSE-Ausfall** (z. B. SumUp-Terminalzahlung bei gestörter TSE, ohne Signatur) sind ebenfalls nachholbar; der Beleg trägt dann den Ausfall-Hinweis statt der TSE-Angaben. Der TSE-Ausfall selbst ist gesondert zu dokumentieren.
- Kennzeichnung: im Kopf des Belegs „Belegart: nachträglich erstellt“ mit dem Zahlungszeitpunkt, darunter ein gut lesbarer Vermerk „Zahlungsbeleg nachträglich erstellt am … (Zahlung vom …)“. Die Zeile „Beleg erstellt:“ unter den TSE-Angaben nennt den Zeitpunkt der Belegerstellung, nicht den der Zahlung oder der TSE-Signatur.

### Grenzen des nachträglichen Zahlungsbelegs
- Der nachträgliche Beleg **heilt die versäumte Belegausgabe nicht** (§ 146a Abs. 2 AO verlangt die Ausgabe in unmittelbarem zeitlichen Zusammenhang mit dem Vorgang). Er schließt die Lücke in den Aufzeichnungen und kann ausgehändigt bzw. nachgesandt werden; der Vorfall sollte in der Verfahrensdokumentation festgehalten werden.
- **Nummer:** laufende Nummer im ZB-Nummernkreis des **Jahres der Erstellung** (nicht des Zahlungsjahres) – bei einer Zahlung vom Dezember, die im Januar nachgeholt wird, also eine Nummer des neuen Jahres.
- **Praxisangaben:** wie am **Tag der Erstellung** (der Zahlungsbeleg ist ein neuer Beleg); Empfänger:in und Kleinunternehmer-Status wie auf der Rechnung.
- **DSFinV-K:** Die ZB-Nummer erscheint nicht im DSFinV-K-Export. Die Zuordnung zur Kassenaufzeichnung erfolgt über Rechnung, Betrag, Zahlungszeitpunkt und die TSE-Transaktion (Transaktionsnummer/Signaturzähler auf dem Beleg).

## Altbelege
- Belege, die vor Einführung des Archivs ausgestellt wurden, werden bei Bedarf neu erzeugt und als „Reproduktion … mit den heutigen Stammdaten“ gekennzeichnet.

## Aufbewahrung
- Buchungsbelege 8 Jahre, Kassenaufzeichnungen und Organisationsunterlagen 10 Jahre ab Ende des Jahres; frühestes Ende, Ablaufhemmung (§ 147 Abs. 3 S. 5 AO) vorbehalten. Die Löschung nach Fristablauf erfolgt derzeit nicht automatisch.
