import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicSite } from "@/server/website";
import { PrivacyContent } from "../_site/legal-content";
import { SiteShell } from "../_site/shell";

export async function generateMetadata(props: PageProps<"/p/[slug]/datenschutz">): Promise<Metadata> {
  const site = await loadPublicSite((await props.params).slug);
  // notFound() schon hier, damit Titel und Metadaten der 404-Seite (../../not-found.tsx) gelten
  if (!site) notFound();
  return { title: { absolute: `Datenschutz · ${site.name}` }, robots: { index: false, follow: true } };
}

/** Datenschutz der Praxis-Website (Inhalt: _site/legal-content.tsx, auch für /buchen/<slug>/datenschutz). */
export default async function SitePrivacy(props: PageProps<"/p/[slug]/datenschutz">) {
  const site = await loadPublicSite((await props.params).slug);
  if (!site) notFound();
  return (
    <SiteShell site={site}>
      <PrivacyContent site={site} />
    </SiteShell>
  );
}
