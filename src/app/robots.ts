import type { MetadataRoute } from "next";
import { absoluteUrl, siteIndexable } from "./(public)/_content/site";

/** Zur Laufzeit ausgewertet: PUBLIC_SITE_INDEX/PUBLIC_URL sind Umgebungsvariablen des Servers, nicht des Builds. */
export const dynamic = "force-dynamic";

/**
 * Oberste Pfade der angemeldeten App ((app), (plattform)) – liefern ohnehin noindex/Weiterleitung, sollen aber gar nicht gecrawlt werden.
 * robots.txt vergleicht Präfixe: "/kunden" sperrt auch "/kunden/…" (und z. B. "/kundenliste"). Keine öffentliche Seite beginnt mit
 * einem dieser Präfixe – bei neuen öffentlichen Pfaden hier gegenprüfen.
 */
const APP_PATHS = [
  "/heute", "/kunden", "/kalender", "/doku", "/verordnungen", "/rechnungen", "/kasse", "/gutscheine", "/produkte", "/auswertung",
  "/posteingang", "/bewertungen", "/hygiene", "/pflegeheime", "/touren", "/team", "/telefon", "/einstellungen", "/willkommen",
  "/bereiche", "/neuigkeiten", "/news", "/nur-lesen", "/plattform",
];

/**
 * robots.txt: Solange PUBLIC_SITE_INDEX nicht "true" ist (Rechtstexte noch nicht anwaltlich geprüft), wird die PodoHero-Website
 * nicht indexiert – die Praxis-Websites unter /p/ (Angebot an die Praxen, eigene Rechtstexte der Praxis) bleiben aber auffindbar.
 * Danach die öffentliche Website; App, API und persönliche Links (Portal, Anamnese, Abmeldung) bleiben ausgeschlossen.
 */
export default function robots(): MetadataRoute.Robots {
  if (!siteIndexable()) return { rules: { userAgent: "*", allow: "/p/", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // App-Bereiche (nur nach Anmeldung) und persönliche Links; /buchen/ und /p/ (Angebote der Praxen) bleiben erlaubt.
      disallow: [
        "/api/", "/portal", "/anamnese/", "/abmelden/", "/login", "/einrichtung", "/entsperren", "/kein-zugriff", "/offline", "/aktion/",
        ...APP_PATHS,
      ],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
