import type { MetadataRoute } from "next";
import { ARTICLES } from "./(public)/_content/articles";
import { COMPETITORS } from "./(public)/_content/competitors";
import { absoluteUrl } from "./(public)/_content/site";

/** PUBLIC_URL wird zur Laufzeit gelesen (im Docker-Build ist sie nicht gesetzt). */
export const dynamic = "force-dynamic";

/**
 * Sitemap der öffentlichen Website (nur statische Marketing-/Wissensseiten, keine Praxis- oder Patientendaten).
 * Praxis-Websites (/p/…) gehören den Praxen und stehen hier bewusst nicht.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages: [string, MetadataRoute.Sitemap[number]["changeFrequency"], number][] = [
    ["/", "weekly", 1],
    ["/funktionen", "weekly", 0.9],
    ["/preise", "monthly", 0.9],
    ["/vergleich", "monthly", 0.8],
    ["/wechseln", "monthly", 0.8],
    ["/wissen", "weekly", 0.7],
    ["/sicherheit", "monthly", 0.7],
    ["/impressum", "yearly", 0.2],
    ["/datenschutz", "yearly", 0.2],
    ["/agb", "yearly", 0.2],
    ["/avv", "yearly", 0.2],
    ["/unterauftragnehmer", "yearly", 0.2],
  ];
  return [
    ...pages.map(([path, changeFrequency, priority]) => ({ url: absoluteUrl(path), changeFrequency, priority })),
    ...COMPETITORS.map((c) => ({ url: absoluteUrl(`/vergleich/${c.slug}`), changeFrequency: "monthly" as const, priority: 0.7 })),
    ...ARTICLES.map((a) => ({ url: absoluteUrl(`/wissen/${a.slug}`), lastModified: new Date(`${a.modified}T12:00:00Z`), changeFrequency: "monthly" as const, priority: 0.6 })),
  ];
}
