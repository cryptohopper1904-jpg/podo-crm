import type { MetadataRoute } from "next";
import { APP_NAME, PWA_COLORS, PWA_ICONS, PWA_SCREENSHOTS } from "@/lib/pwa/app-meta";

/**
 * Web-App-Manifest der Praxis-App (installierbar auf iPhone, iPad, Android, Desktop-Chrome/Edge).
 * - id/start_url "/heute": bleibt gleich, damit bestehende Installationen dieselbe App bleiben.
 * - scope "/": die Praxis-Seiten haben kein gemeinsames Präfix (/heute, /kalender, /kunden, …).
 * - Patientenportal (/portal), Online-Buchung (/buchen), Anamnese-Links und Praxis-Websites (/p/…) verlinken dieses
 *   Manifest nicht (manifest: null in deren Layouts) – Patient:innen sollen dort nicht „PodoHero“ installieren.
 * Die Dateien prüft src/lib/pwa/pwa-assets.test.ts.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/heute",
    name: APP_NAME,
    short_name: APP_NAME,
    description: "Praxis- und Patientensystem für Podologie",
    lang: "de",
    dir: "ltr",
    start_url: "/heute",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: PWA_COLORS.backgroundLight,
    theme_color: PWA_COLORS.themeLight,
    categories: ["medical", "business", "productivity"],
    icons: [
      { src: PWA_ICONS.svg, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: PWA_ICONS.any192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.any512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: PWA_ICONS.maskable192, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: PWA_ICONS.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Heute", short_name: "Heute", url: "/heute", icons: [{ src: PWA_ICONS.shortcutToday, sizes: "96x96", type: "image/png" }] },
      { name: "Kalender", short_name: "Kalender", url: "/kalender", icons: [{ src: PWA_ICONS.shortcutCalendar, sizes: "96x96", type: "image/png" }] },
      { name: "Neuer Termin", short_name: "Termin", url: "/kalender/neu", icons: [{ src: PWA_ICONS.shortcutNew, sizes: "96x96", type: "image/png" }] },
      { name: "Patientensuche", short_name: "Suche", url: "/kunden?suche=1", icons: [{ src: PWA_ICONS.shortcutSearch, sizes: "96x96", type: "image/png" }] },
    ],
    screenshots: [
      { src: PWA_SCREENSHOTS.narrow.src, sizes: PWA_SCREENSHOTS.narrow.sizes, type: "image/png", form_factor: "narrow", label: "Termine der Woche auf dem Smartphone (Demo-Praxis)" },
      { src: PWA_SCREENSHOTS.wide.src, sizes: PWA_SCREENSHOTS.wide.sizes, type: "image/png", form_factor: "wide", label: "Kalender auf dem Tablet (Demo-Praxis)" },
    ],
  };
}
