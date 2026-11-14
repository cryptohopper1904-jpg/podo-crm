# Lösch- und Aufbewahrungskonzept – Entwurf

| Datenklasse | Aufbewahrung | Grundlage | Umsetzung |
|---|---|---|---|
| Behandlungsdoku, Fotos, Anamnese | 10 Jahre nach Abschluss der Behandlung | § 630f Abs. 3 BGB | Akte wird archiviert (nicht gelöscht); Löschlauf nach Fristablauf (Phase 2, mit Freigabe durch Inhaber) |
| Minderjährige | mind. bis Volljährigkeit + 10 Jahre (rechtlich prüfen) | Rechtsprechung | Sonderregel im Löschlauf |
| Rechnungen, Buchungsbelege | 8 Jahre (seit 2025) | § 147 AO, § 14b UStG | unveränderbar; Löschlauf nach Frist |
| Bücher, Jahresabschlüsse | 10 Jahre | § 147 AO | lexoffice/Steuerberatung |
| Einwilligungen | Dauer der Verarbeitung + Nachweis (3 J.) | Art. 7 Abs. 1 DSGVO | versioniert, append-only |
| Kommunikation (Nachrichten) | 3 Jahre | Verjährung § 195 BGB | Löschlauf |
| Audio der Sprachberichte | nicht gespeichert | Datensparsamkeit | nur flüchtig im Arbeitsspeicher |
| Audit-Log | 2 Jahre (prüfen) | Art. 32 | Löschlauf |
| Backups | Server 14 Tage rollierend; zweiter Standort (sobald eingerichtet) höchstens 30 Tage | – | Backup-Container, `deploy/offsite-backup.example.sh` |

**Löschbegehren (Art. 17)** während laufender Aufbewahrungspflicht: Sperrung statt Löschung (Art. 17 Abs. 3 lit. b), Patient wird informiert, Vorgang protokolliert.
**Kündigung eines SaaS-Kunden:** Vollexport (JSON + Fotos) durch die Praxis; nach Vertragsende höchstens 12 Monate Nur-Lesen-Modus, dann automatische Löschung (Ankündigung mindestens 30 Tage vorher, Erinnerung 7 Tage vorher; Cron `/api/cron/nur-lesen`). Auf Löschantrag Löschung des Mandanten inkl. Dateien nach 30 Tagen Karenzzeit. Backups laufen spätestens 30 Tage nach der Löschung aus.
