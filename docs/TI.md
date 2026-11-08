# Telematikinfrastruktur (TI), KIM und eVerordnung – was die Praxis wissen muss

Stand: November 2026. Termine und Beträge ändern sich – bitte vor Entscheidungen beim jeweiligen Anbieter bzw. Verband prüfen.

## Kurz gesagt
- **Heilmittelerbringer (auch Podologie) müssen laut DigiG seit 01.01.2026 an die TI angeschlossen sein.**
- **PodoCRM ist kein zertifiziertes TI-Produkt.** Wir bauen keinen Konnektor, kein KIM und keinen E-Rezept-Fachdienst nach.
  PodoCRM nutzt die **Standard-Schnittstellen** der zugelassenen Komponenten, die Ihre Praxis bei einem TI-Anbieter bezieht.
- Ohne eigenen TI-Zugang der Praxis funktioniert in PodoCRM alles im **Testmodus** (Beispieldaten, kein Versand).

## Was Ihre Praxis braucht
| Baustein | Wozu | Wo erhältlich | Kosten |
|---|---|---|---|
| **SMC-B** (Praxisausweis, Institutionskarte) | Ausweis der Praxis in der TI, Voraussetzung für alles andere | über das eGBR (elektronisches Gesundheitsberuferegister) bei einem zugelassenen Kartenanbieter; Voraussetzung: Kassenzulassung | beim Anbieter erfragen |
| **eHBA** (elektronischer Heilberufsausweis) | persönliche qualifizierte elektronische Signatur | eGBR / Kartenanbieter | beim Anbieter erfragen |
| **Konnektor** (vor Ort) **oder TI-Gateway** (als Dienst) | sichere Verbindung in die TI | zugelassene TI-Dienstleister | beim Anbieter erfragen |
| **Kartenterminal** | SMC-B und eHBA stecken | über den TI-Dienstleister | beim Anbieter erfragen |
| **KIM-Vertrag** (Kommunikation im Medizinwesen) | sichere E-Mail mit Arztpraxen, Kliniken, Kassen | zugelassene KIM-Anbieter, oft im Paket mit dem TI-Zugang | beim Anbieter erfragen |

**Finanzierung:** Die Krankenkassen erstatten die TI-Kosten über eine monatliche **TI-Pauschale** nach der Finanzierungsvereinbarung für
Heilmittelerbringer. Höhe, Voraussetzungen und Antragsweg bitte beim Berufsverband bzw. GKV-Spitzenverband prüfen – die Pauschale deckt
nicht zwingend jedes Angebot vollständig ab.

## Was PodoCRM übernimmt (unsere Rolle)
### KIM-Postfach im Posteingang
- PodoCRM verbindet sich mit dem **KIM-Clientmodul** Ihres KIM-Anbieters (bzw. dem KIM-Dienst des TI-Gateways) über die
  Standard-Protokolle **POP3S** (Abruf) und **SMTPS** (Versand). Verschlüsselung, Signatur und Adressbuch (Verzeichnisdienst)
  übernimmt das Clientmodul.
- Einrichtung: *Einstellungen → Schnittstellen → KIM* (KIM-Adresse, Benutzername im Format Ihres Anbieters, Hosts/Ports, Passwort –
  verschlüsselt gespeichert). Test: *Einstellungen → TI → KIM-Verbindung testen*.
- Abruf: Knopf **„KIM abrufen“** im Posteingang und automatisch alle 15 Minuten. Doppelte Nachrichten werden über die Message-ID erkannt.
- **Keine automatische Zuordnung** zu Kund:innen: PodoCRM schlägt anhand von Versichertennummer (KVNR), Name und Geburtsdatum vor –
  die Praxis entscheidet.
- Anhänge (z. B. PDF-Arztbriefe) werden **nicht** in PodoCRM gespeichert, nur ihre Namen. Antworten per KIM: nur Text.
- Nachrichten bleiben standardmäßig auf dem KIM-Server (Einstellung „Nach Abruf löschen“ = nein).
- Technische Voraussetzung: Das Clientmodul/Gateway muss für den PodoCRM-Server **per TLS über einen öffentlichen Hostnamen** erreichbar
  sein. Adressen im Praxisnetz (z. B. ein Konnektor im Keller) sind aus Sicherheitsgründen gesperrt – fragen Sie Ihren Anbieter nach
  einem Gateway-/Cloud-Zugang zum KIM-Clientmodul.

### eVerordnung Heilmittel
- Die **Heilmittel-eVerordnung ist laut gematik geplant – Stand prüfen.** Sie ist noch nicht flächendeckend verfügbar; Profile und
  Abläufe können sich bis zum Start ändern.
- PodoCRM kann eine Verordnung als **FHIR-Datei (JSON)** importieren: *Verordnungen → eVerordnung importieren*. Sie sehen eine Vorschau,
  wählen die Person (oder legen sie neu an) und erhalten einen Verordnungsentwurf mit Fristen, Einheiten und Zuzahlung wie gewohnt.
  Jede eVerordnung kann nur einmal importiert werden.
- Den **Abruf** einer eVerordnung aus der TI (Fachdienst, Token) übernimmt Ihr TI-Zugang bzw. Anbieter – nicht PodoCRM.

### Abrechnung
- Die GKV-Abrechnung (§ 302 SGB V) läuft weiterhin über ein Abrechnungszentrum (siehe Verordnungen → Abrechnung).

## Zeitplan (Orientierung)
| Wann | Was |
|---|---|
| seit 01.01.2026 | TI-Anschluss für Heilmittelerbringer verpflichtend (DigiG) |
| jetzt | SMC-B/eHBA beantragen, TI-Zugang und KIM-Anbieter wählen, TI-Pauschale prüfen |
| nach Einrichtung | KIM in PodoCRM eintragen und testen |
| laut gematik geplant – Stand prüfen | Heilmittel-eVerordnung; Import in PodoCRM ist vorbereitet |

## Ehrliche Grenzen
- PodoCRM wurde **nicht** gegen eine echte TI-Umgebung getestet. Getestet sind die Protokolle (POP3/SMTP, MIME, FHIR-Import) gegen
  Testserver und erfundene Beispieldaten.
- Die genauen Anmeldeformate (Benutzername des Clientmoduls), Ports und Zertifikate unterscheiden sich je Anbieter.
  Bei selbst signierten Zertifikaten des Clientmoduls ist derzeit keine Verbindung möglich (Zertifikatsprüfung bleibt immer an).
- Für die Echtnutzung: Datenschutz-Folgenabschätzung und AVV-Fragen mit dem TI-/KIM-Anbieter klären.
