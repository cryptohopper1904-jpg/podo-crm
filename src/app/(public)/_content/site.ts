/**
 * Gemeinsame Angaben der öffentlichen Website (SEO): Basis-URL, Indexierung, Open-Graph-Bild, Metadaten-Bausteine.
 * Ohne Next-/DB-Abhängigkeiten – wird von (public)/layout.tsx (zur Laufzeit), sitemap.ts und robots.ts gelesen.
 */
import type { Metadata } from "next";
import { log } from "@/lib/log";

type Env = Partial<Record<"PUBLIC_URL" | "PUBLIC_SITE_INDEX" | "NODE_ENV", string | undefined>>;

const DEV_FALLBACK = "http://localhost:3000";
let warned = false;

/**
 * Basis-URL der Website aus PUBLIC_URL (ohne Schrägstrich am Ende).
 * Ohne PUBLIC_URL: in der Entwicklung http://localhost:3000; in Produktion einmalige Log-Warnung und derselbe Platzhalter –
 * dann schaltet siteIndexable() die Indexierung ab, damit keine falschen Canonicals in Suchmaschinen landen. Der Build bricht nicht.
 */
export function siteUrl(env: Env = process.env): string {
  const url = env.PUBLIC_URL?.trim();
  if (url && /^https?:\/\/[^/\s]+/.test(url)) return url.replace(/\/+$/, "");
  if (env.NODE_ENV === "production" && !warned) {
    warned = true;
    log.warn("website.public_url_missing", { status: "PUBLIC_URL fehlt oder ist ungültig – Website wird nicht indexiert" });
  }
  return DEV_FALLBACK;
}

export const absoluteUrl = (path: string, env: Env = process.env) => `${siteUrl(env)}${path.startsWith("/") ? path : `/${path}`}`;

/** Indexierung erst nach anwaltlicher Prüfung der Rechtstexte (PUBLIC_SITE_INDEX=true) und nur mit gültiger PUBLIC_URL. */
export const siteIndexable = (env: Env = process.env) => env.PUBLIC_SITE_INDEX === "true" && /^https?:\/\/[^/\s]+/.test(env.PUBLIC_URL?.trim() ?? "");

export const SITE_NAME = "PodoHero";

/** Open-Graph-Standardbild: echter Screenshot mit erfundenen Demodaten (public/screenshots). */
export const OG_IMAGE = { url: "/screenshots/og-podohero.jpg", width: 1200, height: 630, alt: "PodoHero – Tagesüberblick einer Podologie-Praxis mit Terminen, Einnahmen und Posteingang (Demodaten)" };

/**
 * Basis-Metadaten der öffentlichen Website – zur Laufzeit aus den Umgebungsvariablen (siehe generateMetadata in
 * (public)/layout.tsx). metadataBase macht relative Canonicals/Open-Graph-URLs der Unterseiten absolut.
 */
export function publicSiteMetadata(env: Env = process.env): Metadata {
  const indexable = siteIndexable(env);
  return {
    metadataBase: new URL(siteUrl(env)),
    title: { default: "PodoHero – Praxissoftware für Podologie", template: "%s · PodoHero" },
    description:
      "Praxissoftware für Podologie: Patientenakte, Termine, Behandlungsdoku mit Fotos am iPad, Rechnungen, Verordnungen und Kommunikation – gehostet in Deutschland.",
    robots: indexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { type: "website", locale: "de_DE", siteName: SITE_NAME, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image" },
  };
}

/** Metadaten-Baustein für Unterseiten: Canonical + Open Graph mit gleichem Titel/Text (relativ, s. metadataBase). */
export function pageMeta({ title, description, path, type = "website" }: { title: string; description: string; path: string; type?: "website" | "article" }) {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title: `${title} · ${SITE_NAME}`, description, url: path, type, locale: "de_DE", siteName: SITE_NAME, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image" as const, title: `${title} · ${SITE_NAME}`, description, images: [OG_IMAGE.url] },
  };
}
