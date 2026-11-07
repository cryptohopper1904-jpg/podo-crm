# Review: openai/gpt-5.6-sol

## 1) Fachliche/rechtliche Fehler oder veraltete Angaben

- **Deutschland-Hosting ist keine Vorgabe aus Art. 9 DSGVO.** Möglich sind EU-/EWR-Hosting oder Drittlandtransfers mit Art. 44 ff. DSGVO. Deutschland ist eine sinnvolle Risikoreduktion, aber keine Rechtsnorm.
- **DSFA nicht automatisch „bei KI und Gesundheitsdaten“.** Maßgeblich ist ein voraussichtlich hohes Risiko, Art. 35 DSGVO, insbesondere umfangreiche Verarbeitung, Profiling oder neue Technologien. Für ein mandantenfähiges Health-SaaS ist sie sehr wahrscheinlich; für eine kleine Einzelpraxis nicht allein wegen „KI“ zwingend.
- **Einwilligungen werden überstrapaziert.** Behandlungsdokumentation stützt sich regelmäßig auf Art. 6 Abs. 1 lit. b/c und Art. 9 Abs. 2 lit. h DSGVO i. V. m. § 22 BDSG, nicht auf Einwilligung. Separate Einwilligungen braucht man insbesondere für Marketingfotos, werbliche Nachrichten und ggf. Gesprächsaufzeichnungen. Eine WhatsApp-Einwilligung beseitigt keine Transfer-/Metadatenrisiken.
- **Umsatzsteuer ist nicht allein je Leistungscode bestimmbar.** § 4 Nr. 14 UStG verlangt eine konkrete Heilbehandlung mit therapeutischem Ziel und entsprechende Qualifikation. Kosmetische Leistungen bleiben steuerpflichtig; Pakete und gemischte Leistungen müssen gesondert beurteilt werden.
- **PKV nach „GebüH/BEB“ ist falsch.** GebüH betrifft Heilpraktiker, BEB zahntechnische Leistungen. Für Podologen existiert keine allgemein verbindliche private Gebührenordnung. Erforderlich sind eigener Preiskatalog, transparente Honorarvereinbarung und Hinweise zur möglichen Nichterstattung.
- **Gutscheinregel:** § 195 BGB regelt Verjährung, nicht automatisch die Gültigkeit. Der Beginn folgt § 199 BGB. Kürzere vertragliche Befristungen benötigen eine AGB-rechtliche Prüfung. Zusätzlich ist die Einzweck-/Mehrzweckgutscheinlogik nach § 3 Abs. 14/15 UStG abzubilden.
- **TSE-Aussage zu pauschal.** Ein reines Kartenterminal ist keine Kasse. Lexware Office ist nicht automatisch ein TSE-Kassensystem. Sobald PodoCRM Barumsätze elektronisch aufzeichnet, kann es selbst Teil eines elektronischen Aufzeichnungssystems werden: § 146a AO, KassenSichV, Belegausgabe, DSFinV-K und Kassenmeldung prüfen.
- **Fotopflichten falsch zugeordnet.** Sie folgen gegebenenfalls der jeweils aktuellen Leistungsbeschreibung zum Vertrag nach § 125 SGB V, nicht pauschal „G-BA/§ 125“. UI1/UI2, Anlass und Zeitpunkt müssen exakt aus der aktuellen Vertragsfassung modelliert werden.
- **„Pflichtdokumentation“ enthält Übermaß.** HbA1c, Wagner/Armstrong, MRSA, Fußpulse oder Stimmgabel sind nicht bei jedem Patienten Pflicht. Formulare müssen indikationsabhängig sein; sonst entstehen unnötige Gesundheitsdaten und fachliche Haftungsrisiken.
- **Chargenrückverfolgung zum Patienten ist nicht pauschal aus IfSG/MPBetreibV ableitbar.** Anforderungen hängen von Instrumentenklassifikation, Landes-Hygienerecht, KRINKO/BfArM-Empfehlung und Aufbereitungsverfahren ab.
- **MDR-Risiko wird unterschätzt.** Der Hinweis „keine Diagnose“ genügt nicht. Entscheidend ist die Zweckbestimmung, Art. 2 Nr. 1 MDR. Medizinisch interpretierter Fotovergleich oder Risikopriorisierung kann Software als Medizinprodukt, regelmäßig nach Regel 11, qualifizieren.
- **Stand 07.11.2026 und „eVerordnung ab 2027?“** sind Zukunftsannahmen und vor Release anhand verbindlicher Spezifikationen neu zu validieren.

## 2) Fehlende Funktionen/Anforderungen

- Verordnungsmanagement im MVP: Fristen, Frequenz, Unterbrechungen, Zuzahlung/Befreiung, Hausbesuch, Absetzungen, Leistungsbestätigung.
- Korrektur-, Storno- und Gutschriftenworkflow statt nur „unveränderbar“.
- Aufbewahrungs-, Sperr- und Löschkonzept je Datenklasse; Art. 15/20 DSGVO-Export auch maschinenlesbar, nicht nur PDF.
- Betreuer/Vollmachten, Minderjährige, verstorbene Patienten, Identitätsprüfung bei Auskunft.
- Digitale Anamnese und rechtskonforme Signatur bereits im MVP.
- Dienstzeiten, Pausen, Abwesenheiten, Doppelbuchungsregeln und No-Show-Ausfallhonorar.
- Kassenabschluss, Kassensturz, Einlage/Entnahme, Export für Betriebsprüfung.
- Datenmigration inklusive Validierungsbericht, Dublettenfreigabe und revisionssicherer Herkunft.
- Incident-Response, Datenschutzverletzungen nach Art. 33/34 DSGVO, Supportzugriffsprozess.
- Exit-Export und kontrollierte Mandantenlöschung inklusive Backups.

## 3) Architektur-/Sicherheitsrisiken

- Docker Compose/Coolify auf einem Einzelserver ist kein belastbares SaaS-Betriebsmodell: Single Point of Failure, fehlendes RPO/RTO, Restore-Tests, Hochverfügbarkeit und Patch-SLA.
- RLS schützt nicht automatisch Storage, Redis, Jobs, Exporte, Logs oder signierte URLs. Mandantenzuordnung muss serverseitig aus der Session kommen.
- `pgcrypto` ohne externes Schlüsselmanagement bringt wenig; Schlüssel gehören in KMS/HSM, mit Rotation und Trennung von Datenbankadministration.
- Hash-Ketten in derselben administrierbaren Datenbank sind kein manipulationssicherer Nachweis. Externe Signierung/WORM-Speicherung erwägen.
- PWA-Offlinespeicherung von Fotos/Audios ist auf privaten iPhones riskant. Face ID/WebAuthn verschlüsselt nicht automatisch IndexedDB. MVP besser ohne Offline-Medien oder nur auf MDM-Firmengeräten.
- Super-Admin mit Vollzugriff widerspricht Least Privilege. Just-in-time-Supportzugriff, Vier-Augen-Freigabe und Patientenakten-Pseudonymisierung vorsehen.
- Sentry, GitHub Actions, E-Mail-Parsing und Kalenderfeeds können Gesundheitsdaten leaken. PHI-Redaction und Lieferkettenkontrollen fehlen.
- Doctolib-E-Mail-/iCal-Parsing ist fragil, möglicherweise vertragswidrig und erzeugt Konflikte. Kein „Sync“ ohne Konfliktmodell und verbindliche API.

## 4) Wettbewerb: fehlende Analyse

Zusätzlich prüfen: **thevea/opta data**, **azh TiM**, **RZH-Lösungen**, **Thera-Pi**, **lemniscus**, **appointmed** sowie Portale von Abrechnungszentren. Nicht nur Featurelisten vergleichen, sondern GKV-Absetzungsquote, Migration, Support, TSE, TI-Kosten, Vertragsbindung und Gesamtpreis. Aussagen wie „kein Mitbewerber“ oder „Marktführer/zu groß“ sind unbelegt; außerdem fehlen mindestens 15–20 Praxisinterviews.

## 5) Falsche MVP-Priorisierung

Phase 1 ist für einen Entwickler in 6–8 Wochen unrealistisch. Fußgrafik, Sprache-KI, SumUp, E-Mail-Postfach, Tourenplanung, Finanzplanung und Gutscheine konkurrieren mit den existenziellen Funktionen Dokumentation, Kalender, Abrechnung und Datenschutz. Wenn die Zielpraxis GKV behandelt, ist die Verschiebung von Verordnung/GKV auf P3/P4 ein Product-Market-Fit-Fehler.

## 6) Top-10 konkrete Verbesserungen

1. Zielsegment anhand GKV-/Selbstzahleranteil verbindlich festlegen.  
2. MVP auf Akte, Kalender, indikationsabhängige Doku, Fotos, Rechnung und Export reduzieren.  
3. Aktuellen §-125-Vertrag in versionierte, testbare Regeln übersetzen.  
4. Kassenentscheidung vor Entwicklung schriftlich steuerrechtlich klären.  
5. GebüH/BEB entfernen; privaten Podologie-Preiskatalog modellieren.  
6. DSFA, Berechtigungskonzept und Löschmatrix vor Produktivdaten abschließen.  
7. Offline-Fotos zunächst verbieten; Firmengeräte mit MDM einsetzen.  
8. GKV-Basis einschließlich Verordnungsprüfung ins MVP nehmen oder klar reines Selbstzahlerprodukt bauen.  
9. Professionelles Betriebsmodell mit KMS, Restore-Tests, RPO/RTO und Incident-Runbooks einführen.  
10. Roadmap realistisch auf 4–6 Monate für einen produktionsfähigen Praxis-MVP verlängern.