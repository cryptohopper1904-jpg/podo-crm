# Beleg-Archiv und Zahlungsbelege – Baustein für die Verfahrensdokumentation (GoBD)

> Entwurf als Arbeitsgrundlage für die Verfahrensdokumentation der Praxis, **keine Steuerberatung**.

## Was beim Ausstellen passiert
- Rechnung, Quittung, Anzahlung, Sammelrechnung und Stornorechnung werden in einer Datenbank-Transaktion ausgestellt (Nummer, Beträge, Leistungsdatum, Momentaufnahme der Praxis- und Empfängerangaben in `invoices.issued_snapshot`). Danach sind diese Angaben per Trigger unveränderbar.
- Als letzter Schritt derselben Transaktion wird das PDF erzeugt und verschlüsselt abgelegt (`document_archive`: SHA-256, Größe, Dateiname). Download, E-Mail-Anhang und Patientenportal liefern genau diese Bytes aus.
- Spätere Zahlungen (bar, Karte, Gutschein; SumUp-Terminal) erhalten je Kassenvorgang einen eigenen „Beleg über Zahlungseingang“ (Nummernkreis ZB) mit TSE-Angaben; die Angaben werden mit der Zahlung festgeschrieben (`payment_receipts`), das PDF unmittelbar danach archiviert.

## Wenn die Ablage scheitert (Nachholen)
- Ein Ablagefehler (Speicher, Schlüssel, Erzeugung) macht den Beleg nicht ungültig und rollt keine TSE-signierte Zahlung zurück. Die Praxis erhält eine Meldung im Posteingang.
- Das PDF wird **aus den festgeschriebenen Angaben** nachgeholt: beim nächsten Abruf und im Hintergrundlauf (Cron, mit wachsender Wartezeit nach Fehlversuchen). Erst danach wird es ausgehändigt; bis dahin lehnen Download, E-Mail-Versand und Portal mit „PDF wird gerade erzeugt“ ab – es wird **keine unarchivierte Fassung** ausgegeben.
- Ein nachträglich (mehr als 10 Minuten nach dem Ausstellen bzw. der Zahlung) erzeugtes PDF trägt den Vermerk „PDF nachträglich erzeugt am …“; jedes erfolgreiche Nachholen wird im Audit-Log protokolliert.

### Bekannte Abweichungen beim Nachholen
- **PDF-Programmcode:** Das nachgeholte PDF wird mit dem zum Zeitpunkt des Nachholens aktuellen Programmstand erzeugt (Layout kann sich gegenüber dem Ausstellungstag unterscheiden; Belegtexte und Beträge sind durch Tests festgehalten).
- **Logo:** Das Praxis-Logo wird nicht in der Momentaufnahme gespeichert (beim Austausch wird die alte Datei gelöscht). Ein nachgeholtes PDF zeigt das zum Erzeugungszeitpunkt hinterlegte Logo; alle übrigen Angaben (Praxis, Anschrift, Bankverbindung, Steuernummer, Empfänger, Zahlungen beim Ausstellen, Anrechnungen) stammen aus den festgeschriebenen Daten.

## Zahlungsbeleg fehlt
- Kann die Zeile des Zahlungsbelegs bei der Buchung nicht angelegt werden, bleibt die Zahlung samt TSE-Signatur gebucht; „Zahlung erfassen“ zeigt eine deutliche Warnung, und auf der Rechnungsseite erscheint „Zahlungsbeleg fehlt“.
- Mit dem Recht „Rechnungen bearbeiten“ kann der Zahlungsbeleg dort gezielt **nachträglich erstellt** werden (nur für TSE-signierte Zahlungen nach Ausstellung der Rechnung, je Zahlung höchstens einmal, Vermerk „nachträglich erstellt am …“). Eine automatische Massennachholung für Altzahlungen gibt es bewusst nicht.

## Altbelege
- Belege, die vor Einführung des Archivs ausgestellt wurden, werden bei Bedarf neu erzeugt und als „Reproduktion … mit den heutigen Stammdaten“ gekennzeichnet.

## Aufbewahrung
- Buchungsbelege 8 Jahre, Kassenaufzeichnungen und Organisationsunterlagen 10 Jahre ab Ende des Jahres; frühestes Ende, Ablaufhemmung (§ 147 Abs. 3 S. 5 AO) vorbehalten. Die Löschung nach Fristablauf erfolgt derzeit nicht automatisch.
