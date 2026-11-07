import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Native Hülle für iPad/iPhone (App Store / TestFlight).
 * Die App lädt die Praxis-Instanz über HTTPS (server.url) – es liegen keine Patientendaten in der App selbst.
 * Vorteile ggü. reiner Web-App: kein iOS-Speicher-Löschen, Kamera ohne Mediathek, Face ID, Push.
 * Einrichtung: siehe docs/IOS-APP.md
 */
const config: CapacitorConfig = {
  appId: "de.podocrm.app",
  appName: "PodoCRM",
  webDir: "public",
  server: {
    url: process.env.CAP_SERVER_URL ?? "https://crm.deine-praxis.de",
    cleartext: false,
  },
  ios: {
    contentInset: "always",
    limitsNavigationsToAppBoundDomains: true,
  },
};

export default config;
