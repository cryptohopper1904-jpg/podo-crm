import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicSite } from "@/server/website";
import { ImprintContent } from "../_site/legal-content";
import { SiteShell } from "../_site/shell";

export async function generateMetadata(props: PageProps<"/p/[slug]/impressum">): Promise<Metadata> {
  const site = await loadPublicSite((await props.params).slug);
  // notFound() schon hier, damit Titel und Metadaten der 404-Seite (../../not-found.tsx) gelten
  if (!site) notFound();
  return { title: { absolute: `Impressum · ${site.name}` }, robots: { index: false, follow: true } };
}

/** Impressum der Praxis-Website (Inhalt: _site/legal-content.tsx, auch für /buchen/<slug>/impressum). */
export default async function SiteImprint(props: PageProps<"/p/[slug]/impressum">) {
  const site = await loadPublicSite((await props.params).slug);
  if (!site) notFound();
  return (
    <SiteShell site={site}>
      <ImprintContent site={site} />
    </SiteShell>
  );
}
