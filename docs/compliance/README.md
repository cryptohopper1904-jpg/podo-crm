# Datenschutz & Compliance – Entwürfe

> ⚠️ Entwürfe als Arbeitsgrundlage, **keine Rechtsberatung**. Vor dem Echtbetrieb mit Datenschutzbeauftragter/m bzw. Fachanwalt für Medizinrecht abstimmen.

| Dokument | Zweck | Status |
|---|---|---|
| [TOM.md](TOM.md) | Technische und organisatorische Maßnahmen (Art. 32 DSGVO) – direkt aus dem Code abgeleitet | Entwurf |
| [VVT.md](VVT.md) | Verzeichnis der Verarbeitungstätigkeiten (Art. 30) | Entwurf |
| [LOESCHKONZEPT.md](LOESCHKONZEPT.md) | Aufbewahrung und Löschung je Datenklasse | Entwurf |
| [DSFA.md](DSFA.md) | Datenschutz-Folgenabschätzung (Art. 35) – Gerüst | Entwurf |
| [UNTERAUFTRAGNEHMER.md](UNTERAUFTRAGNEHMER.md) | AVV-Kette (Hosting, KI, WhatsApp, SMS …) | offen |
| [BELEG-ARCHIV.md](BELEG-ARCHIV.md) | Beleg-Archiv, Zahlungsbelege, Nachholen – Baustein Verfahrensdokumentation (GoBD) | Entwurf |
| [PENTEST-CHECKLISTE.md](PENTEST-CHECKLISTE.md) | Pentest-Plan (OWASP ASVS L2) inkl. `pnpm audit --prod` | Entwurf |

## Checkliste vor dem ersten echten Patienten
- [ ] AVV mit Hoster, § 203-Verpflichtung der IT-Dienstleister
- [ ] TOM geprüft und unterschrieben
- [ ] VVT ergänzt (Praxisdaten, DSB)
- [ ] DSFA durchgeführt (bei KI-Funktionen / SaaS sehr wahrscheinlich nötig)
- [ ] Datenschutzhinweise für Patienten (Aushang + Formular), Einwilligungsformulare (Fotos Werbung, WhatsApp, Erinnerungen, KI, Aufzeichnung)
- [ ] KI/Transkription: Anbieter in EU mit AVV + Zero Data Retention, erst dann `*_DATA_PROCESSING_APPROVED=true`
- [ ] Backup-Wiederherstellung getestet
- [ ] 2FA für alle Konten aktiv
- [ ] Fotopflichten gegen aktuelle Leistungsbeschreibung § 125 SGB V geprüft (`src/lib/rules/brace.ts`)
- [ ] USt-Behandlung der Leistungen mit Steuerberatung abgestimmt; Bar-Kasse/TSE geklärt
