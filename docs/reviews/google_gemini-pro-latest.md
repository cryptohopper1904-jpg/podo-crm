# Review: ~google/gemini-pro-latest

Hier ist das kritische Review deines Masterplans aus Sicht von Produktmanagement, Recht, Architektur und Praxisalltag.

### 1) Fachliche/rechtliche FEHLER oder veraltete Angaben

*   **TI-Pflicht & eVerordnung (Kap. 6.4):** Die Annahme „eVerordnung ab 2027?“ ist gefährlich. Laut **§ 360 Abs. 4 SGB V** (geändert durch das Digital-Gesetz – DigiG) ist der Anschluss an die Telematikinfrastruktur (TI) für Heilmittelerbringer ab **01.01.2026** Pflicht, die elektronische Heilmittelverordnung ab **01.01.2027**. Ohne TI-Strategie ist das Produkt ab 2026 für GKV-Praxen unverkäuflich.
*   **Umsatzsteuer-Befreiung (Kap. 1 & 4.4):** **§ 4 Nr. 14 Buchst. a UStG** befreit Heilbehandlungen nur, wenn eine **ärztliche Verordnung** (GKV oder Privatrezept) oder eine Diagnose vorliegt. Reine Selbstzahler-Leistungen ohne Rezept (auch durch Podologen!) sind meist mit 19 % USt-pflichtig (BFH-Rechtsprechung). Dein System braucht im Datenmodell zwingend eine Verknüpfung zu „Diagnose/Privatrezept liegt vor“, um 0 % USt rechtssicher im Selbstzahler-Bereich anzuwenden.
*   **E-Rechnungspflicht fehlt (Kap. 4.4):** Seit **01.01.2025** gilt die E-Rechnungspflicht im B2B-Bereich (**Wachstumschancengesetz**, § 14 UStG). Relevant, wenn Podologen für Pflegeheime oder Ärzte abrechnen (XRechnung/ZUGFeRD).
*   **lexoffice-Kasse (Kap. 3.1):** Es gibt **keine** „lexoffice-Kasse mit TSE“. Lexware Office (ehem. lexoffice) ist eine Buchhaltungssoftware, kein Kassenbuch und kein Kassensystem. Barzahlungen erfordern zwingend ein echtes POS-System mit TSE (z. B. SumUp POS, ready2order) + Kassenbuchführung.
*   **PKV-Abrechnung (Kap. 4.4):** Es gibt für Podologen **keine GebüH** (gilt nur für Heilpraktiker). PKV und Beihilfe orientieren sich an den GKV-Sätzen (mit Faktor, z. B. 1,4- bis 2,3-fach) oder der Bundesbeihilfeverordnung (BBhV).

### 2) Fehlende Funktionen/Anforderungen (Praxisalltag)

*   **Heim- und Hausbesuchs-Management:** Viele Podologen betreuen Pflegeheime (10–20 Patienten an einem Tag am selben Ort). Es fehlen: Sammel-Dokumentation (Listenansicht für ein Heim), Abrechnung mit Heimträgern/Betreuern (abweichender Rechnungsempfänger!) und Sammelquittungen.
*   **Ausfallhonorar-Automatisierung:** Nach **§ 615 BGB** (Annahmeverzug) sind No-Show-Rechnungen im Praxisalltag essenziell. Dafür braucht es rechtssichere AGB-Einwilligungen bei der Terminbuchung und einen 1-Klick-Workflow für Ausfallrechnungen.
*   **Verordnungskontrolle für Selbstzahler/PKV:** Wegen der USt-Thematik (siehe Punkt 1) muss das System ablaufende Privatrezepte (z. B. 1 Jahr Gültigkeit) tracken und den Behandler warnen, sonst droht bei der Betriebsprüfung eine USt-Nachzahlung.
*   **Handschuhe-Bedienbarkeit:** Im Praxisalltag trägt der Podologe Handschuhe, Hände sind voll Hornhautstaub oder Creme. Eine „Doku in 60 Sekunden“ funktioniert nur, wenn der Sprachbefehl den Prozess *komplett* steuert (Hands-free-Modus) oder Buttons extrem groß sind.

### 3) Architektur-/Sicherheitsrisiken

*   **PWA & Offline-Modus auf iOS (Kap. 4.3, 7):** Apple beschneidet PWAs massiv (Storage-Eviction nach 7 Tagen Inaktivität, unzuverlässiger Background-Sync, Probleme bei Kamera-Berechtigungen nach Updates). Verschlüsselter lokaler Speicher (IndexedDB) im Browser kann bei iOS-Updates verloren gehen. **Risiko:** Datenverlust von Pflichtfotos. *Lösung:* Direkt auf Capacitor (native Hülle) setzen, nicht erst später.
*   **Einzelner Hetzner-Server + Coolify (Kap. 7, 9):** Für die eigene Praxis okay, für ein Multi-Tenant-SaaS mit Daten nach **Art. 9 DSGVO** ein No-Go. Kein automatisches Failover, komplexe Key-Management-Anforderungen (KMS fehlt für sauberes Field-Level-Encryption), schwierige Zertifizierbarkeit (ISO 27001 des Hosters reicht nicht, wenn der Stack selbst gebastelt ist).
*   **Google-Maps-Link in Excel/Stammdaten (Kap. 1):** Wenn die Praxis die Patientenadresse ungefragt an die Google Maps API schickt, um Routen zu berechnen, ist das eine Übermittlung von Gesundheitsdaten (Kontext: „Person ist Patient einer Podologie“) an Google. Erfordert strikte Anonymisierung (nur PLZ/Straße ohne Namen) oder selbst gehostetes OSRM.
*   **Audit-Log für Lesezugriffe (Kap. 4.10):** In Postgres über einfache Trigger für `SELECT` nicht nativ möglich (nur über `pgAudit` und das flutet die DB). Besser auf Applikationsebene im API-Layer lösen.

### 4) Wettbewerb: Was fehlt in der Analyse?

Der deutsche Markt wird von **Abrechnungszentren** dominiert, die eigene Software pushen:
*   **Optica Viva** (Optica Abrechnungszentrum) & **noventi Ora** (ehem. azh TiM): Sehr stark im Markt, weil direkt mit Vorfinanzierung gekoppelt.
*   **SOVDWAER (THEORG):** Hat mit *THEORG Go* inzwischen auch mobile Lösungen.
*   **Buchner (buchnerFLOW / Starke Praxis):** Sehr stark im Bereich Wissensvermittlung und Heilmittel-Regelwerk.
*   **mediDOK:** Oft in größeren Praxen für rechtssichere Bildarchivierung genutzt.
*   **Dein blinder Fleck:** Reine Selbstzahler-Praxen sind oft *kosmetische Fußpfleger* (keine Podologen). Echte Podologen (mit Kassenzulassung) machen meist 70–90 % GKV-Umsatz. Ohne GKV-Modul im MVP adressierst du nur eine kleine Nische (Privat-Podologen).

### 5) Priorisierung: Was ist im MVP (P1) falsch priorisiert?

Dein MVP (6–8 Wochen für 1 Entwickler) ist **massiv überladen** und realistisch eher 6 Monate Arbeit.
*   **Raus aus P1:** Eigener E-Mail-Posteingang (IMAP/SMTP-Sync ist ein Albtraum bei Edge-Cases), Fußgrafik mit Punkt-Kürzeln (fressen Wochen im UI-Bau), Offline-Modus (extrem komplexe Konflikt-Logik), Finanzplanung/Kalkulation (dafür reicht erstmal weiter das Excel-Blatt!).
*   **Falscher Fokus bei lexoffice (Kap. 4.4):** Wenn lexoffice „führend für Belege“ ist, kann lexoffice **keine Mischzahlungen** (z. B. 20 € Gutschein + 30 € Bar) und keine Teilzahlungen sauber über die API abbilden. Das CRM muss führend sein, lexoffice bekommt nur den Buchungsbeleg.

### 6) Top-10 konkrete Verbesserungen

1.  **USt-Wächter einbauen:** Verknüpfe jede 0 %-USt-Leistung bei Selbstzahlern zwingend mit einem hochgeladenen Privatrezept/Arztbrief inkl. Ablaufdatum.
2.  **KassenSichV sauber lösen:** Nutze die **SumUp POS API** (nicht nur die Payment-API) oder binde eine Cloud-TSE (z. B. **fiskaly**) direkt an dein Rechnungsmodul an. Nur so darfst du Bar-Quittungen im CRM erzeugen.
3.  **Rechnungs-Hoheit ins CRM holen:** Erzeuge PDFs und Nummernkreise im CRM (inkl. Gutschein-Verrechnung) und übertrage sie per `/v1/vouchers`-Endpunkt (Beleg-API) an Lexware Office, statt die Rechnungs-API von Lexware zu nutzen.
4.  **Capacitor ab Tag 1:** Überspring die reine PWA für iOS. Ein Capacitor-Wrapper kostet 1 Tag Setup und gibt dir sicheren Zugriff auf den nativen iOS Keychain und das Dateisystem für Pflichtfotos.
5.  **MVP radikal kürzen:** P1 = Stammdaten (Excel-Import) + Kalender + Foto-/Sprach-Doku + Rechnungsstellung/SumUp. Kein E-Mail-Client, keine Fußgrafik (Freitext + Foto-Tagging reicht für V1), kein Offline-Modus.
6.  **Abweichender Rechnungsempfänger:** Baue ins Datenmodell ab Tag 1 eine Relation `patient -> billing_contact` (für gesetzliche Betreuer, Angehörige, Pflegeheime).
7.  **Hands-Free Sprach-UI:** Baue die iPhone-Doku so, dass man zu Behandlungsbeginn „Start“ drückt und per Voice-Command („Foto links D1“, „Spange gesetzt“) durch den Prozess geführt wird, ohne das Display mit kontaminierten Handschuhen zu berühren.
8.  **Doctolib-Workaround härten:** Da du keine Partner-API bekommst: Baue einen Inbound-E-Mail-Parser (z. B. via Postmark), der die Doctolib-Buchungsbestätigungs-Mails der Praxis in Echtzeit ausliest und Termine im CRM anlegt.
9.  **GKV-Schnittstelle vorziehen (von P4 auf P2):** Nutze einen Anbieter mit moderner API für § 302 (z. B. über den offenen Standard oder Kooperation mit einem kleineren Rechenzentrum), sonst kannst du das SaaS nicht an Kassenpraxen verkaufen.
10. **AVV & Hosting professionalisieren:** Nutze für Produktivdaten von Kundenpraxen **managed PostgreSQL** (z. B. Hetzner Managed DB oder AWS RDS Frankfurt) mit automatischem Point-in-Time-Recovery statt einer selbst verwalteten Docker-DB unter Coolify.