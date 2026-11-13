# iPad/iPhone-App (Capacitor)

Die Oberfläche ist für iPad am Behandlungsstuhl und iPhone unterwegs (Hausbesuche) optimiert.

## Variante A: Web-App / PWA (sofort, iPhone, iPad, Android, Desktop)
Anleitung für Nutzer:innen in der App: **Einstellungen → App installieren** (`/einstellungen/app`), öffentlich unter `/app`.
iOS: Safari → Praxis-URL → Teilen → „Zum Home-Bildschirm“. Android/Chrome/Edge: Knopf „Installieren“ im Hinweis bzw. Menü → „App installieren“.
Kamera und Mikrofon funktionieren direkt. Unter iOS kann Safari Website-Daten nach längerer Nichtnutzung löschen (betrifft nur die Anmeldung, nicht die Patientendaten – die liegen auf dem Server).

Technik:
- **Manifest** `src/app/manifest.ts`: `id`/`start_url` `/heute`, `scope` `/`, Verknüpfungen (Heute, Kalender, Neuer Termin, Patientensuche), Bildschirmfotos aus der Demo-Praxis.
  Icons, Favicons und iOS-Startbilder (`public/icons`, `public/splash`, `src/app/favicon.ico`) erzeugt `pnpm exec tsx scripts/generate-pwa-assets.ts`; Manifest-Bildschirmfotos `PWA_MANIFEST_SHOTS=1 pnpm exec playwright test e2e/web-app.spec.ts -g Bildschirmfotos`.
- **Service Worker** `/sw.js` (`src/app/sw.js/route.ts`, Regeln `src/lib/pwa/sw-rules.ts`), nur im Produktions-Build registriert:
  cacht **nur** `/_next/static`, Icons, Startbilder, Logo und die statische Offline-Seite `/offline`. Nie Praxis-Seiten, API, RSC-Daten,
  Server-Action-POSTs, PDFs oder Fotos. Seitenaufrufe gehen immer ans Netz; ohne Verbindung erscheint `/offline`.
  Jeder Build hat eine neue Cache-Version (`PODO_APP_VERSION`, sonst Build-Zeitpunkt); alte Caches werden gelöscht.
  Eine neue Version übernimmt erst nach „Neue Version verfügbar – Neu laden“.
- **Patientenportal** (`/portal`), Online-Buchung (`/buchen`), Anamnese-Links und Praxis-Websites (`/p/…`) verlinken das Manifest
  bewusst nicht und haben kein eigenes – Patient:innen sollen dort nicht „PodoHero“ (Start auf `/heute`) installieren. Der Service Worker
  zeigt auf diesen Seiten auch keinen PodoHero-Offline-Hinweis.
- Ein Gerät, auf dem die Praxis-App installiert ist, nutzt den Service Worker für die ganze Domain (Scope `/`); auch dort gilt: nur statische Dateien.

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
