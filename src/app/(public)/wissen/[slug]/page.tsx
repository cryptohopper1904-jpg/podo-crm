import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ExternalLink, Info } from "lucide-react";
import { LinkButton } from "@/components/ui";
import { articleBySlug, ARTICLES } from "../../_content/articles";
import { Breadcrumbs } from "../../_content/faq-list";
import { articleLd, breadcrumbLd, JsonLd } from "../../_content/json-ld";
import { pageMeta } from "../../_content/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: PageProps<"/wissen/[slug]">): Promise<Metadata> {
  const a = articleBySlug((await params).slug);
  if (!a) return {};
  const meta = pageMeta({ title: a.title, description: a.description, path: `/wissen/${a.slug}`, type: "article" });
  return { ...meta, openGraph: { ...meta.openGraph, publishedTime: a.published, modifiedTime: a.modified } };
}

const dateDe = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Berlin" });
const anchor = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default async function ArticlePage({ params }: PageProps<"/wissen/[slug]">) {
  const a = articleBySlug((await params).slug);
  if (!a) notFound();
  const path = `/wissen/${a.slug}`;
  const trail = [
    { name: "Wissen", path: "/wissen" },
    { name: a.title, path },
  ];
  const more = ARTICLES.filter((x) => x.slug !== a.slug).slice(0, 3);
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <JsonLd data={[breadcrumbLd(trail), articleLd({ title: a.title, description: a.description, path, published: a.published, modified: a.modified })]} />
      <Breadcrumbs trail={trail} />
      <div className="mt-6 grid gap-10 lg:grid-cols-[1fr_280px]">
        <article className="min-w-0 max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">{a.topic} · {a.minutes} Min. Lesezeit</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight sm:text-4xl">{a.title}</h1>
          <p className="mt-2 text-sm text-muted">
            Stand: <time dateTime={a.modified}>{dateDe(a.modified)}</time> · PodoHero-Redaktion
          </p>
          <p className="mt-6 text-lg">{a.intro}</p>

          {a.legal ? (
            <p className="mt-6 flex gap-2.5 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
              <Info size={18} aria-hidden className="mt-0.5 shrink-0" />
              <span>
                Allgemeiner Überblick, keine Rechts- oder Steuerberatung. Regeln ändern sich; maßgeblich sind die verlinkten Originalquellen. Für Ihre
                Praxis klären Sie Einzelfragen bitte mit Steuerberatung, Rechtsberatung bzw. Ihrem Berufsverband.
              </span>
            </p>
          ) : null}

          {a.sections.map((s) => (
            <section key={s.heading} aria-labelledby={anchor(s.heading)} className="mt-10">
              <h2 id={anchor(s.heading)} className="scroll-mt-24 font-display text-2xl font-semibold">{s.heading}</h2>
              {s.paragraphs?.map((p) => <p key={p} className="mt-3 text-[16px] leading-relaxed">{p}</p>)}
              {s.list ? (
                s.ordered ? (
                  <ol className="mt-3 list-decimal space-y-2 pl-6 leading-relaxed">{s.list.map((l) => <li key={l}>{l}</li>)}</ol>
                ) : (
                  <ul className="mt-3 list-disc space-y-2 pl-6 leading-relaxed">{s.list.map((l) => <li key={l}>{l}</li>)}</ul>
                )
              ) : null}
            </section>
          ))}

          <section aria-labelledby="quellen" className="mt-12 border-t border-border pt-6">
            <h2 id="quellen" className="font-display text-xl font-semibold">Quellen</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              {a.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} rel="noopener noreferrer" target="_blank" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                    {s.label} <ExternalLink size={14} aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </article>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          {a.feature ? (
            <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
              <p className="font-semibold">In PodoHero</p>
              <Link href={a.feature.href} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
                {a.feature.label} <ArrowRight size={16} aria-hidden />
              </Link>
              <LinkButton href="/einrichtung" variant="accent" className="mt-4 w-full">30 Tage kostenlos testen</LinkButton>
            </div>
          ) : null}
          <nav aria-label="Weitere Artikel" className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <p className="font-semibold">Weitere Artikel</p>
            <ul className="mt-2 space-y-2 text-sm">
              {more.map((m) => (
                <li key={m.slug}><Link href={`/wissen/${m.slug}`} className="text-muted hover:text-text hover:underline">{m.title}</Link></li>
              ))}
            </ul>
          </nav>
        </aside>
      </div>
    </div>
  );
}
