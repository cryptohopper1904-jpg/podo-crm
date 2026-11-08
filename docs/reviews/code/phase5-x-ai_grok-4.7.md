# Code-Review (Sicherheit): x-ai/grok-4.7

Kritisch

1. `src/server/kasse.ts` (`loadItems`, `buildDsfinvkExport`) und `src/lib/kasse/model.ts` (`itemsDigest`). USt-Gruppen und Gutscheine werden beim Export/PDF live aus `invoice_lines`/`vouchers` neu gelesen. `itemsDigest` hasht nur id, Zahlart, Betrag, Zeitpunkt. Die Prüfung `lastBonNr`/`itemsDigest` vergleicht nicht mit `row.totals`. Nach dem Z-Bon geänderte Rechnungssätze oder Gutscheinzwecke ändern die DSFinV-K-Einzelaufzeichnung, ohne dass die Hash-Kette bricht. GoBD-Umgehung, falsche USt gegenüber der Finanzverwaltung. Fix: Bonpositionen beim Abschluss als jsonb mitspeichern, Export nur daraus, USt-Aufteilung in den Digest, betroffene Rechnungszeilen sperren.

2. `src/server/kasse.ts` `closingTse` und `src/lib/kasse/dsfinvk.ts` `transactions_tse.csv`/`tse.csv`. Gespeichert werden nur `closingRef` und die TSE-Referenz der letzten Zahlung (`lastRef`), nicht Signatur, Start/Ende, Public Key, Zertifikat. Der Export schreibt `TSE_TA_SIG`, `TSE_TA_START`, `TSE_TA_ENDE`, `TSE_PUBLIC_KEY`, Zertifikate als `""`. Ein Kassenabschluss ist damit nicht nach KassenSichV prüfbar. Fix: vollständige TSE-Antwort unveränderlich speichern und exportieren; Abschluss abbrechen, wenn sie fehlt.

Hoch

3. `closingTse` und `dsfinvk.ts` (`if (b.tse && !b.tse.isTest)`). `externalRef` mit Präfix `tse:test:` setzt `isTest`. Im Produktivmodus wird der Abschluss trotzdem `fiskaly`, der Bon fällt aus `TSE_Transaktionen`. Wer `external_ref` setzen kann, entfernt die TSE-Einzelaufzeichnung. Fix: Test-Referenzen im Produktivmodus ablehnen; fehlende echte Signatur nicht still überspringen.

4. `drizzle/0015_phase5_kasse_security.sql` `podo_payment_closing_guard`, INSERT-Zweig. Jede neue Zahlung mit `cash_closing_id IS NULL` ist erlaubt, auch wenn `(paid_at AT TIME ZONE 'Europe/Berlin')::date` schon einen Z-Bon hat. `loadItems` zieht alle unzugeordneten Zahlungen in den nächsten Abschluss. Barzahlungen lassen sich nachträglich in einen geschlossenen Tag datieren. Fix: INSERT nur für Systemrolle/Webhook und `paid_at` nach `closed_at` des letzten Abschlusses; Nutzer-Inserts auf geschlossene Tage verbieten.

5. `src/server/waitlist.ts` `acceptOffer`. Slot-Zeit und Status werden vor der Sperre gelesen. Unter der Sperre wird der Ursprungstermin nicht neu gelesen und in der Überschneidungsprüfung immer ausgenommen (`r.id !== slot.id`), auch wenn er nicht mehr `cancelled` ist. Doppelbelegung. Fix: Termin unter `FOR UPDATE` neu laden, nur bei `cancelled` buchen, ihn in die Overlap-Prüfung einbeziehen.

6. `src/lib/kasse/model.ts` `buildBons` (`note: m.reason`) und `dsfinvk.ts` `BON_NOTIZ`. Freitext aus Einlage/Entnahme und Kassendifferenz (bis 300 Zeichen) landet unveränderlich im Z-Bon und im Steuer-Export. In einem Podologie-CRM ist das ein Art.-9-Abfluss, der wegen des UPDATE-Verbots nicht löschbar ist. Fix: Grund auf ein Kürzel-Enum begrenzen, Freitext nicht in Fiskalexport und Hash übernehmen.

7. `dsfinvk.ts` `GUTSCHEIN_NR`/`ARTIKELTEXT` und `kasse.ts` `loadItems`. Gutscheincodes stehen klartext im ZIP und in `getClosing` für jedes `invoices.read`. Sind Codes einlösbar, ist der Export ein Credential-Leak. Fix: nur gekürzte Referenz exportieren, Einlösecode nicht in Bontext.

8. `src/server/waitlist.ts` `offerFreedSlot`. Nach erfolgreichem Versand wird `urls.push(url)` mit dem Roh-Token ausgeführt, auch außerhalb des Testmodus, und in `OfferSummary` zurückgegeben. Der Token nimmt den Termin für den Patienten an. Fix: Token nie zurückgeben; nur im Mock und nur serverseitig.

9. `src/app/api/health/deep/route.ts`. Fehlt `HEALTH_TOKEN`, gilt `CRON_SECRET`. Monitoring-Kompromittierung autorisiert Cron-Aufrufe und umgekehrt. Fix: ausschließlich `HEALTH_TOKEN`, kein Fallback.

10. `deploy/update.sh`. `exec 9>"${TMPDIR:-/tmp}/podo-crm-update.lock"` folgt Symlinks und kürzt das Ziel. Als root lokal ausnutzbar. Fix: Lock unter `$APP_DIR` oder `/run`, `O_NOFOLLOW`/`set -C`, Verzeichnis `0700`.

Mittel

11. `podo_cash_closing_sequence` prüft nur Nummer, `prev_hash`-Zeiger und Datum, nicht `hash = chainHash(prev, content)`. `buildDsfinvkExport` ruft `verifyClosingRows` nicht auf. Fix: Kette vor dem Export prüfen und bei Bruch abbrechen; Hash in der DB nachrechnen.

12. `loadItems`: `sold.find(invoiceId)` hängt den ersten Gutschein der Rechnung an jede Zahlung. Falsche Gutscheinart und falscher Code im Bon. Fix: Zuordnung über die Zahlungs- bzw. Positions-ID, nicht über die erste Zeile.

13. `src/lib/kasse/dsfinvk.ts` `quote`. Felder werden nur gequotet. Excel wertet `=`, `+`, `-`, `@` in `BON_NOTIZ`, `ARTIKELTEXT`, Praxisname aus. Fix: solche Zellen mit `'` präfixen.

14. `closingTse` reicht die Anbieter-Exception gekürzt (300 Zeichen) als `KasseError` an den Client. Fix: generische Meldung, Detail nur ins Server-Log ohne Zugangsdaten.

15. `loadClosing`/`getClosing` gibt die komplette `organizations`-Zeile an `invoices.read` zurück, inklusive `settings`. Fix: nur Name, Adresse, Steuernummern, Kassen-ID.

16. `podo_cash_movement_guard` lässt INSERT mit beliebigem `occurred_at` zu. Rückdatierte Entnahmen fehlen im schon geschriebenen Z-Bon und verfälschen den nächsten. Fix: `occurred_at` nicht vor `closed_at` des letzten Abschlusses und nicht in der Zukunft.

17. `addCashMovement`/`closeDay`: `audit()` liegt nach dem Commit. Absturz erzeugt Fiskaldaten ohne Audit. Fix: Audit in derselben Transaktion.

18. `src/lib/error-report.ts` `scrubRoute`. Ohne `routePath` bleiben Namenssegmente und IDs mit weniger als drei Ziffern (`/kunden/42`) stehen und gehen an Sentry/Webhook. Fix: ohne Routenmuster nur Methode und Digest senden.

19. `deploy/restore.sh`. `tar -C /data/storage -xz --strip-components=1` ohne Schutz vor `..`. Präpariertes Datei-Backup schreibt außerhalb des Volumes. Fix: `--no-absolute-names` und Einträge mit `..` verwerfen.

Niedrig

20. `src/server/kasse.ts` `loadItems`/`loadClosing`: `users` wird nur über `id` gelesen, ohne `organization_id`. Bei fehlender RLS auf `users` Namen anderer Mandanten, falls `created_by` mandantenfremd ist. Fix: Join über die Mandantenmitgliedschaft.