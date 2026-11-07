# Review: mistralai/mistral-large-4-0

**1) Fachliche/rechtliche FEHLER oder veraltete Angaben**

- **WhatsApp mit Gesundheitsdaten ist rechtswidrig.** Die Cloud API läuft über Meta (US); Meta ist kein geeigneter Auftragsverarbeiter für Art. 9-Daten. Selbst Terminerinnerungen mit Patientennamen verstoßen gegen § 203 StGB und Art. 9 DSGVO. Lösung: KIM (TI) oder SMS/E-Mail für medizinische Inhalte; WhatsApp nur für nicht-medizinische Erinnerungen mit Risiko-Hinweis in der Einwilligung.
- **PKV-Abrechnung nach „GebüH/BEB“ ist falsch.** Podologen sind keine Heilpraktiker; Privatabrechnungen erfolgen analog **GOÄ** (ggf. mit abweichendem Faktor) oder individueller Honorarvereinbarung.
- **Lexoffice ist keine Kasse.** Barzahlungen benötigen eine TSE-fähige elektronische Kasse (§ 146a AO, KassenSichV). Lexoffice ist nur Buchhaltung; das Kassenmodul muss separat an SumUp-TSE (oder andere zertifizierte Kasse) angebunden werden, inkl. Zählprotokoll.
- **Rechtsgrundlage unvollständig.** Primäre Grundlage für die Verarbeitung ist **Art. 9 Abs. 2 lit. h DSGVO** (Behandlung durch Gesundheitsfachpersonal), nicht die Einwilligung. Einwilligung nur für Marketing/KI/WhatsApp.
- **Minderjährige vergessen:** Aufbewahrung nicht nur 10 Jahre, sondern bis zur Volljährigkeit + 10 Jahre (BGH, Urt. v. 20.03.2018 – VI ZR 135/17).
- **Fotos „nie auf der Kamerarolle“ ist technisch nicht trivial.** iOS-Standard-APIs speichern in der Fotos-App. Das erfordert AVFoundation mit direktem Upload ohne Library-Save – sonst Verstoß gegen das Konzept.
- **DFS-Risikoklassifikation:** Nicht nur Wagner/Armstrong, sondern **IWGDF-Risikoklassen (0–3)** nach der Nationalen VersorgungsLeitlinie (NVL) Diabetisches Fußsyndrom.
- **Doctolib:** AVV als Auftragsverarbeiter fehlt in der rechtlichen Aufzählung.

**2) Fehlende Funktionen/Anforderungen**

- **Systematische Wunddokumentation** (Wundrand, -grund, -umgebung, Exsudat, Geruch, Größe nach TIME-Konzept) für DFS/Ulkus – nicht nur Foto.
- **Verordnungsmanagement:** Fristen für Behandlungsbeginn und Frequenzkontrolle nach § 125 SGB V, nicht nur OCR.
- **Hygiene-Checklisten:** Tägliche Kontrollen, Sterilisationsindikatoren, Gerätebuch nach MPBetreibV, Validierungsprotokolle.
- **eHBA-Authentifizierung** (2FA) für spätere TI-Anbindung.
- **FHIR/HL7-Schnittstelle** für strukturierte eArztbriefe.
- **Ausfallhonorar (No-Show):** AGB-konforme Regelung (§ 615 BGB) mit rechtssicherer Dokumentation.
- **Betroffenenrechte-Workflow:** Löschbegehren (Art. 17 DSGVO) vs. gesetzliche Aufbewahrung (§ 630f BGB – Aufbewahrung geht vor, aber Prozess dokumentieren).
- **Notfallprotokoll** für akute Verschlechterungen (Diabetiker mit Wunde, Infekt).

**3) Architektur-/Sicherheitsrisiken**

- **GitHub für Infrastruktur-Code:** US-Anbieter; Secrets und Deployment-Keys dürfen nicht im Repo liegen. Besser GitLab self-hosted (DE) oder GitHub Enterprise mit AVV.
- **Row-Level-Security allein unsicher.** Bei Gesundheitsdaten: Database-per-Tenant oder strikte Mandantentrennung auf Applikationsebene plus RLS als zweite Schicht.
- **Offline-Modus:** Lokale Verschlüsselung auf dem iPhone erfordert sicheres Key-Management (Secure Enclave/Keychain), sonst bei Gerätediebstahl Datenleck.
- **Supabase Auth (GoTrue):** Bekannte Schwachstellen; besser Keycloak oder Ory.
- **KI/LLM:** „EU-Endpunkt“ reicht nicht; vertraglich **Zero Data Retention** und kein Training auf Kundendaten bei Microsoft/Mistral/AWS sicherstellen.
- **Backups:** Verschlüsselt, aber kein Restore-Test im Plan.

**4) Wettbewerb: was fehlt**

APTergo, x-tention (Pflege/Podologie), Software der Berufsverbände (VDP, ZFD), spezialisierte Nischenanbieter (z. B. „Praxisfee“, „JUST“), generische Health-Clouds (**Salesforce Health Cloud**, **Microsoft Dynamics 365 Healthcare**) und **Samedi** als Buchungs-Alternative zu Doctolib.

**5) Priorisierung: was im MVP falsch priorisiert**

P1 ist überladen: **KI-Sprachbericht** (DSFA-pflichtig, MDR-Risiko), **WhatsApp API** und **Offline-Modus** gehören in P2. **DSFA, AVV-Kette und TOMs müssen vor dem ersten echten Patienten** (Phase 0) fertig sein, nicht parallel. **GKV-Abrechnung als Phase 4** ist strategisch falsch, wenn der Zielmarkt GKV-Praxen sind (~80 % des Marktes); entweder klare Positionierung „nur Selbstzahler“ oder GKV-Partner (opta data, AZH) ab Phase 2.

**6) Top-10 konkrete Verbesserungen**

1. WhatsApp nur für nicht-medizinische Terminerinnerungen (mit Risiko-Hinweis), medizinische Doku über KIM/SMS/E-Mail.
2. PKV-Abrechnung auf GOÄ umstellen; „GebüH“ streichen.
3. Kassenmodul klar trennen: TSE-fähige Kasse (SumUp) für Bar, lexoffice nur als Export-Ziel für Belege.
4. DSFA + vollständige AVV-Kette (Hoster, KI, WhatsApp, Google, Microsoft) vor MVP-Go-Live abschließen; Verzeichnis der Verarbeitungstätigkeiten anlegen.
5. Client-seitige Verschlüsselung (Zero-Knowledge) für Fotos/Audio; Schlüssel beim Mandanten, KMS in DE (z. B. Vault).
6. MVP reduzieren auf: Akte, Kalender, Text-Doku + Foto (ohne KI-Sprache), eigene Rechnung mit lexoffice-Export – kein WhatsApp API, kein Offline.
7. Wunddokumentation als strukturiertes Formular (TIME) für DFS ergänzen.
8. GitLab self-hosted für Infrastruktur-Code; Secrets in HashiCorp Vault, nicht im Repo.
9. GKV-Strategie klären: entweder MVP explizit für reine Selbstzahler-Praxen positionieren oder GKV-Partner ab Phase 2 einbinden.
10. Penetrationstest und Backup-Restore-Test vor erstem Einsatz echter Patientendaten.