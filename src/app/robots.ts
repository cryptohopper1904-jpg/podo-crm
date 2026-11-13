import type { MetadataRoute } from "next";
import { absoluteUrl, siteIndexable } from "./(public)/_content/site";

/** Zur Laufzeit ausgewertet: PUBLIC_SITE_INDEX/PUBLIC_URL sind Umgebungsvariablen des Servers, nicht des Builds. */
export const dynamic = "force-dynamic";

/**
 * robots.txt: Solange PUBLIC_SITE_INDEX nicht "true" ist (Rechtstexte noch nicht anwaltlich geprüft), wird nichts indexiert.
 * Danach nur die öffentliche Website; App, API und persönliche Links (Portal, Anamnese, Abmeldung) bleiben ausgeschlossen.
 */
export default function robots(): MetadataRoute.Robots {
  if (!siteIndexable()) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/portal", "/anamnese/", "/abmelden/", "/login", "/einrichtung", "/entsperren", "/kein-zugriff"],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
