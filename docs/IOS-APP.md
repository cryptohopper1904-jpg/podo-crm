# iPad/iPhone-App (Capacitor)

Die Oberfläche ist für iPad am Behandlungsstuhl und iPhone unterwegs (Hausbesuche) optimiert.

## Variante A: Web-App (sofort)
Safari → Praxis-URL öffnen → Teilen → „Zum Home-Bildschirm“. Kamera und Mikrofon funktionieren direkt.
Einschränkungen unter iOS: Safari kann Website-Daten nach längerer Nichtnutzung löschen (betrifft nur die Anmeldung, nicht die Patientendaten, die liegen auf dem Server).

## Variante B: native Hülle (empfohlen für den Praxisbetrieb)
Die App ist eine schlanke Hülle, die die Praxis-Instanz per HTTPS lädt. Patientendaten werden **nicht** auf dem Gerät gespeichert.

Voraussetzungen: Mac mit Xcode, Apple-Developer-Konto (99 €/Jahr).

```bash
pnpm install
CAP_SERVER_URL=https://crm.deine-praxis.de pnpm exec cap add ios
pnpm exec cap open ios
```
In Xcode:
1. Team und Bundle-ID (`de.podocrm.app`) setzen
2. `Info.plist`: `NSCameraUsageDescription` = „Für die Fotodokumentation der Behandlung“, `NSMicrophoneUsageDescription` = „Für den gesprochenen Besuchsbericht“
3. `WKAppBoundDomains` mit der Praxis-Domain eintragen
4. Archivieren → TestFlight → auf die Praxis-Geräte verteilen

## Geräte-Empfehlung
- Nur **Firmengeräte**, ideal mit MDM (z. B. Jamf, Apple Business Essentials): Code-Sperre, Fernlöschung, keine iCloud-Fotomediathek
- Fotos werden aus der App direkt verschlüsselt hochgeladen und **nicht** in der Mediathek gespeichert
- Für den Mehrmandanten-Verkauf: eine App, Praxis-URL beim ersten Start wählbar (Phase 3)
