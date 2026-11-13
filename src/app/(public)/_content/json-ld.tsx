import { absoluteUrl, OG_IMAGE, SITE_NAME } from "./site";

/**
 * Strukturierte Daten (schema.org) als <script type="application/ld+json">.
 * Nur statische, eigene Inhalte; „<“ wird maskiert (siehe Next-Guide „JSON-LD“), damit kein HTML ausbrechen kann.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}

/** Ohne „offers“: Preise sind noch vorläufig und sollen nicht als verbindliche Angebote in Suchergebnissen erscheinen. */
export function softwareApplicationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Praxissoftware für Podologie",
    operatingSystem: "Web (Browser), iPad, iPhone",
    inLanguage: "de-DE",
    url: absoluteUrl("/"),
    image: absoluteUrl(OG_IMAGE.url),
    description:
      "Praxissoftware nur für Podologie: Patientenakte, Termine, Behandlungsdoku mit Fußschema und Fotos am iPad, Rechnungen, Sammelrechnung, Kasse, Verordnungen, Hygiene, Pflegeheime und Touren – gehostet in Deutschland.",
  };
}

export function faqLd(items: readonly (readonly [string, string])[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
}

export function breadcrumbLd(trail: readonly { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "Startseite", path: "/" }, ...trail].map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: absoluteUrl(t.path) })),
  };
}

export function articleLd(a: { title: string; description: string; path: string; published: string; modified: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.title,
    description: a.description,
    inLanguage: "de-DE",
    datePublished: a.published,
    dateModified: a.modified,
    mainEntityOfPage: absoluteUrl(a.path),
    image: absoluteUrl(OG_IMAGE.url),
    author: { "@type": "Organization", name: `${SITE_NAME}-Redaktion` },
    publisher: { "@type": "Organization", name: SITE_NAME, logo: { "@type": "ImageObject", url: absoluteUrl("/icons/icon-512.png") } },
  };
}
