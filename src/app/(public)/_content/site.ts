/**
 * Gemeinsame Angaben der öffentlichen Website (SEO): Basis-URL, Seitenliste für sitemap.ts, Open-Graph-Bild.
 * Bewusst ohne Next-/DB-Abhängigkeiten – wird auch von src/app/sitemap.ts und robots.ts gelesen.
 */
import { PUBLIC_PLANS } from "./plans";

/** Basis-URL der Website (PUBLIC_URL, ohne Schrägstrich am Ende) – Fallback nur für lokale Entwicklung. */
export function siteUrl(): string {
  return (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export const absoluteUrl = (path: string) => `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;

/** Indexierung erst nach anwaltlicher Prüfung der Rechtstexte (siehe src/app/(public)/layout.tsx). */
export const siteIndexable = () => process.env.PUBLIC_SITE_INDEX === "true";

export const SITE_NAME = "PodoHero";

/** Open-Graph-Standardbild: echter Screenshot mit erfundenen Demodaten (public/screenshots). */
export const OG_IMAGE = { url: "/screenshots/og-podohero.jpg", width: 1200, height: 630, alt: "PodoHero – Tagesüberblick einer Podologie-Praxis mit Terminen, Einnahmen und Posteingang (Demodaten)" };

/** Metadaten-Baustein für Unterseiten: Canonical + Open Graph mit gleichem Titel/Text. */
export function pageMeta({ title, description, path, type = "website" }: { title: string; description: string; path: string; type?: "website" | "article" }) {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title: `${title} · ${SITE_NAME}`, description, url: path, type, locale: "de_DE", siteName: SITE_NAME, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image" as const, title: `${title} · ${SITE_NAME}`, description, images: [OG_IMAGE.url] },
  };
}

/** Preise als Zahl (netto, EUR) für JSON-LD-Angebote – aus den öffentlichen Tarifen abgeleitet. */
export function planOffers() {
  return PUBLIC_PLANS.filter((p) => p.id !== "trial").map((p) => ({
    name: p.name,
    price: p.price.replace(/[^\d,]/g, "").replace(",", ".") || "0",
    note: [p.period, p.therapists].filter(Boolean).join(", "),
  }));
}
