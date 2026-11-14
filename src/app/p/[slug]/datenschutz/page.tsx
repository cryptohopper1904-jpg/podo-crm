import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicSite } from "@/server/website";
import { SiteShell } from "../_site/shell";

export async function generateMetadata(props: PageProps<"/p/[slug]/datenschutz">): Promise<Metadata> {
  const site = await loadPublicSite((await props.params).slug);
  // notFound() schon hier, damit Titel und Metadaten der 404-Seite (../../not-found.tsx) gelten
  if (!site) notFound();
  return { title: { absolute: `Datenschutz · ${site.name}` }, robots: { index: false, follow: true } };
}

/** Datenschutzerklärung: Text der Praxis; ohne Text ein Hinweis auf die technische Gestaltung der Seite. */
export default async function SitePrivacy(props: PageProps<"/p/[slug]/datenschutz">) {
  const site = await loadPublicSite((await props.params).slug);
  if (!site) notFound();
  return (
    <SiteShell site={site}>
      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="font-display text-3xl font-semibold">Datenschutz</h1>
        <section className="mt-6 rounded-xl bg-surface-2 p-4 text-[15px] leading-relaxed">
          <h2 className="font-semibold">Technische Hinweise zu dieser Website</h2>
          <p className="mt-2">
            Diese Website setzt keine Cookies, verwendet keine Analyse- oder Tracking-Werkzeuge und bindet keine Inhalte von Drittanbietern ein
            (Karten werden nur als Link geöffnet). Beim Aufruf verarbeitet der Server technisch notwendige Verbindungsdaten (z. B. IP-Adresse, Zeitpunkt),
            um die Seite auszuliefern und vor Missbrauch zu schützen. Eine gewählte Hell-/Dunkel-Darstellung wird nur lokal in Ihrem Browser gespeichert.
          </p>
        </section>
        {site.privacy ? (
          <div className="mt-6 whitespace-pre-line leading-relaxed">{site.privacy}</div>
        ) : (
          <p className="mt-6 rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
            Die vollständige Datenschutzerklärung der Praxis (Verantwortliche Stelle, Zwecke, Rechtsgrundlagen, Ihre Rechte, Online-Buchung) wird hier noch ergänzt.
            Bei Fragen wenden Sie sich bitte direkt an die Praxis{site.email ? ` (${site.email})` : ""}.
          </p>
        )}
      </article>
    </SiteShell>
  );
}
