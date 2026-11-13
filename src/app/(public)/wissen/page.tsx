import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui";
import { ARTICLES } from "../_content/articles";
import { Breadcrumbs } from "../_content/faq-list";
import { breadcrumbLd, JsonLd } from "../_content/json-ld";
import { absoluteUrl, pageMeta } from "../_content/site";

export const dynamic = "force-static";

export const metadata = pageMeta({
  title: "Wissen für Podologie-Praxen",
  description:
    "Praxiswissen für die Podologie: Sammelrechnung und Quittung, Umsatzsteuer nach § 4 Nr. 14 UStG, Verordnungen DF/NF/QF, Hygieneplan-Checkliste sowie Hausbesuche und Pflegeheime organisieren.",
  path: "/wissen",
});

const dateDe = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Berlin" });

export default function KnowledgeHub() {
  const trail = [{ name: "Wissen", path: "/wissen" }];
  const list = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: ARTICLES.map((a, i) => ({ "@type": "ListItem", position: i + 1, url: absoluteUrl(`/wissen/${a.slug}`), name: a.title })),
  };
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <JsonLd data={[breadcrumbLd(trail), list]} />
      <Breadcrumbs trail={trail} />
      <header className="mt-6 max-w-3xl">
        <Badge tone="primary"><BookOpen size={14} aria-hidden className="mr-1" /> Praxiswissen</Badge>
        <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">Wissen für Podologie-Praxen</h1>
        <p className="mt-4 text-lg text-muted">
          Kompakte Überblicke zu Abrechnung, Steuern, Verordnungen, Hygiene und Organisation – mit Quellen zum Nachlesen. Keine Rechts- oder
          Steuerberatung.
        </p>
      </header>
      <ul className="mt-10 grid gap-4 md:grid-cols-2">
        {ARTICLES.map((a) => (
          <li key={a.slug}>
            <Link href={`/wissen/${a.slug}`} className="group flex h-full flex-col rounded-[var(--radius-card)] border border-border bg-surface p-6 hover:border-primary">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">{a.topic} · {a.minutes} Min. Lesezeit</span>
              <span className="mt-2 font-display text-xl font-semibold group-hover:text-primary">{a.title}</span>
              <span className="mt-2 flex-1 text-[15px] text-muted">{a.description}</span>
              <span className="mt-4 flex items-center justify-between text-sm">
                <span className="text-muted">Stand: {dateDe(a.modified)}</span>
                <span className="inline-flex items-center gap-1 font-semibold text-primary">Lesen <ArrowRight size={16} aria-hidden /></span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
