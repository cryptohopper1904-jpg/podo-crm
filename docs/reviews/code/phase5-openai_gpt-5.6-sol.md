# Code-Review (Sicherheit): openai/gpt-5.6-sol

## Kritisch

- **`src/server/kasse.ts`, `closeDay()` / Aufruf `closingTse()` innerhalb `withOrg()`**
  - **Problem:** `registerCashPointClosing()` erzeugt einen externen TSE-Vorgang, bevor DB-Insert und Zahlungszuordnungen abgeschlossen sind. Ein späterer DB-/Commit-Fehler rollt nur PostgreSQL zurück, nicht die TSE-Meldung.
  - **Auswirkung:** TSE enthält einen Abschluss ohne lokalen Z-Bon; Wiederholung kann doppelte bzw. widersprüchliche Abschlüsse erzeugen. Der Kommentar „auch die TSE-Meldung wird zurückgerollt“ ist technisch falsch.
  - **Fix:** Persistenten Status `pending` samt stabiler `closingId` zuerst committen, TSE danach mit idempotentem Schlüssel aufrufen und Abschluss in zweiter Transaktion finalisieren; fehlgeschlagene Zustände per Reconciliation verarbeiten.

## Hoch

- **`src/lib/kasse/model.ts`, `itemsDigest()`; `src/server/kasse.ts`, `loadItems()` und `buildDsfinvkExport()`**
  - **Problem:** Der Digest umfasst nur ID, Zahlart, Betrag und Zeitpunkt. Rechnungsnummer, USt-Gruppen aus `invoiceLines`, Gutschein-Code/-Art, `externalRef`, Ersteller und Bewegungsgrund fehlen. Der Export rekonstruiert diese Werte später aus veränderbaren Tabellen.
  - **Auswirkung:** Nachträgliche Änderungen an Rechnungspositionen, Gutscheinen oder TSE-Referenzen verändern DSFinV-K-Bons, ohne dass `itemsDigest` oder Hash-Kette anschlagen.
  - **Fix:** Vollständige, kanonische Bon-Daten beim Abschluss unveränderbar snapshotten und hashen; Export ausschließlich aus diesem Snapshot erzeugen. Alternativ alle verwendeten Felder in den Digest aufnehmen und ihre Quellzeilen nach Abschluss DB-seitig sperren.

- **`src/server/kasse.ts`, `closeDay()` und `addCashMovement()`**
  - **Problem:** Unveränderbare Fiskalaktionen verlangen lediglich `invoices.write`. DSFinV-K-Export und Z-Bon verlangen nur `invoices.read`.
  - **Auswirkung:** Benutzer mit allgemeiner Rechnungsberechtigung können Kassenabschlüsse auslösen bzw. vollständige Steuer-, Umsatz- und Bedienerdaten exportieren, obwohl dies wesentlich weitergehende Rechte sind.
  - **Fix:** Separate Rechte wie `cash.close`, `cash.movement`, `cash.export` und `cash.read` prüfen; bestehende Rechnungsrechte nicht dafür wiederverwenden.

- **`src/server/waitlist.ts`, `acceptOffer()`**
  - **Problem:** `findOffer()` lädt den freigewordenen Termin vor Transaktion und Advisory-Lock. Innerhalb der Transaktion wird der Ursprungstermin weder gesperrt noch erneut auf `status = cancelled` und unveränderte Zeiten geprüft. Bei der Kollisionsprüfung wird `slot.id` stets ausgeschlossen.
  - **Auswirkung:** Wird der Ursprungstermin parallel reaktiviert oder verschoben, kann trotzdem ein zweiter überlappender Termin angelegt werden.
  - **Fix:** Ursprungstermin innerhalb derselben Transaktion `FOR UPDATE` neu laden, Status und Zeiten validieren und nur einen weiterhin abgesagten Termin ausschließen; zusätzlich eine DB-seitige Überschneidungssperre verwenden.

- **`deploy/restore.sh`, Datei-Restore per `tar -C /data/storage ...`**
  - **Problem:** Das Restore überschreibt nur gleichnamige Dateien; neuere Dateien bleiben ausdrücklich erhalten, während die Datenbank auf einen älteren Stand ersetzt wird.
  - **Auswirkung:** Gesundheitsdokumente ohne verbleibenden DB-Bezug bleiben unauffindbar im Storage und können weder regulär angezeigt noch über Lösch-/Aufbewahrungsprozesse erfasst werden.
  - **Fix:** In ein leeres neues Storage-Verzeichnis/Volume restaurieren und DB plus Storage atomar umschalten; alten Bestand anschließend kontrolliert löschen oder separat verschlüsselt quarantänisieren.

## Mittel

- **`src/server/kasse.ts`, Audit-Aufrufe nach `withOrg()`**
  - **Problem:** Kassenbewegung und Abschluss werden zuerst committen, erst danach wird `audit()` ausgeführt.
  - **Auswirkung:** Bei Audit-Fehler oder Prozessabbruch existiert die Fiskaländerung ohne Audit-Eintrag; bei `addCashMovement()` sieht der Aufrufer einen Fehler und kann durch Wiederholung eine zweite Bewegung erzeugen.
  - **Fix:** Audit-/Outbox-Datensatz in derselben DB-Transaktion schreiben und nachgelagert ausliefern; mutierende Aufrufe zusätzlich idempotent machen.

- **`src/server/waitlist.ts`, `OfferSummary.urls` und `offerFreedSlot()`**
  - **Problem:** Die Funktion gibt vollständige Einmal-URLs inklusive Bearer-Token zurück.
  - **Auswirkung:** Jeder Aufrufer, Logger oder serialisierte Rückgabewert kann die Tokens offenlegen und damit Termine im Namen der Patienten annehmen.
  - **Fix:** `urls` aus Produktiv-Rückgaben entfernen; für Tests nur injizierbare Token-Sinks oder Link-IDs verwenden.

- **`src/server/waitlist.ts`, manuelle Fallback-Nachricht**
  - **Problem:** Bei fehlender Einwilligung werden voller Name, Telefonnummer und Wartelistenwunsch in eine allgemeine Nachricht mit `patientId: null` kopiert.
  - **Auswirkung:** Gesundheitsbezogene Wünsche werden aus der Patientenakte dupliziert und verlieren deren direkte Zuordnung sowie mögliche aktenbezogene Zugriffs-/Löschkontrollen.
  - **Fix:** Nachricht nur mit Patienten-ID und internem Aktenlink erzeugen; Telefonnummer und Wunsch zur Anzeige berechtigt aus der Akte laden.

- **`src/lib/kasse/dsfinvk.ts`, `quote()`**
  - **Problem:** Benutzerkontrollierte CSV-Felder werden zwar gequotet, aber führende `=`, `+`, `-` oder `@` bleiben erhalten.
  - **Auswirkung:** Bewegungsgründe, Notizen oder Stammdaten können beim Öffnen in Tabellenkalkulationen als Formeln interpretiert werden.
  - **Fix:** Für Textfelder Formelpräfixe neutralisieren oder einen Exportmodus verwenden, der solche Werte explizit als Text kennzeichnet.