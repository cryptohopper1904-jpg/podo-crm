import { EXPLAINER_VIDEO } from "./explainer-video";
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
      "Praxissoftware nur für Podologie: Patientenakte, Terminplanung mit Online-Buchung, Behandlungsdoku mit Fußschema und Fotos am iPad, GKV-Abrechnung über ein Abrechnungszentrum, Rechnungen, Kasse mit TSE-Anbindung, Hygiene, Pflegeheime und Touren – gehostet in Deutschland.",
    featureList: [
      "GKV-Verordnungen mit Verordnungsprüfung, Unterschrift je Behandlung, Leistungsnachweis und Abrechnungslauf",
      "Zuzahlungsquittung mit Kassenbuchung, Therapiebericht und Folgeverordnung",
      "Terminplanung, Online-Buchung, Patientenportal und Warteliste",
      "Kasse mit Z-Bon, DSFinV-K-Export und TSE-Anbindung",
      "Behandlungsdoku mit Fußschema in 2D und 3D",
      "Hygiene, Sterilgut-Chargen und Gerätebuch",
    ],
    publisher: { "@type": "Organization", name: SITE_NAME, url: absoluteUrl("/") },
  };
}

/** Organisation hinter der Website – bewusst nur Name, URL und Logo (keine Anschrift/Kontaktdaten, solange das Impressum Entwurf ist). */
export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: absoluteUrl("/"),
    logo: absoluteUrl("/icons/icon-512.png"),
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

/** Erklärvideo der Startseite (schema.org VideoObject); Dateien liegen auf dem eigenen Server (public/video). */
export function videoObjectLd() {
  const v = EXPLAINER_VIDEO;
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: v.title,
    description: v.description,
    thumbnailUrl: [absoluteUrl(v.wide.poster.jpg)],
    contentUrl: absoluteUrl(v.wide.src),
    uploadDate: v.uploadDate,
    duration: v.durationIso,
    inLanguage: "de",
  };
}
