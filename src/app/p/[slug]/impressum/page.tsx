import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicSite } from "@/server/website";
import { SiteShell } from "../_site/shell";

export async function generateMetadata(props: PageProps<"/p/[slug]/impressum">): Promise<Metadata> {
  const site = await loadPublicSite((await props.params).slug);
  // notFound() schon hier, damit Titel und Metadaten der 404-Seite (../../not-found.tsx) gelten
  if (!site) notFound();
  return { title: { absolute: `Impressum · ${site.name}` }, robots: { index: false, follow: true } };
}

/** Impressum (§ 5 DDG): Stammdaten aus den Praxis-Einstellungen + Pflichtangaben, die die Praxis selbst ergänzt. */
export default async function SiteImprint(props: PageProps<"/p/[slug]/impressum">) {
  const site = await loadPublicSite((await props.params).slug);
  if (!site) notFound();
  return (
    <SiteShell site={site}>
      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="font-display text-3xl font-semibold">Impressum</h1>
        <h2 className="mt-6 font-semibold">Angaben gemäß § 5 DDG</h2>
        <p className="mt-2 leading-relaxed">
          {site.legalName ?? site.name}<br />
          {site.street ? <>{site.street}<br />{site.zip} {site.city}<br /></> : null}
        </p>
        <h2 className="mt-6 font-semibold">Kontakt</h2>
        <p className="mt-2 leading-relaxed">
          {site.phone ? <>Telefon: {site.phone}<br /></> : null}
          {site.email ? <>E-Mail: {site.email}</> : null}
        </p>
        {site.vatId || site.taxNumber ? (
          <>
            <h2 className="mt-6 font-semibold">Steuerangaben</h2>
            <p className="mt-2">{site.vatId ? `USt-IdNr.: ${site.vatId}` : `Steuernummer: ${site.taxNumber}`}</p>
          </>
        ) : null}
        {site.imprint ? (
          <p className="mt-6 whitespace-pre-line leading-relaxed">{site.imprint}</p>
        ) : (
          <p className="mt-6 rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
            Die Praxis ergänzt hier noch die weiteren Pflichtangaben (u. a. vertretungsberechtigte Person, Berufsbezeichnung und Staat der Verleihung,
            zuständige Aufsichtsbehörde, berufsrechtliche Regelungen).
          </p>
        )}
      </article>
    </SiteShell>
  );
}
