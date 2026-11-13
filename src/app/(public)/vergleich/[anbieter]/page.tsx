import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { COMPARISON_RETRIEVED, COMPARISON_STAND, competitorBySlug, COMPETITORS, type CompareRow, type Competitor } from "../../_content/competitors";
import { Breadcrumbs, FaqList } from "../../_content/faq-list";
import { breadcrumbLd, faqLd, JsonLd } from "../../_content/json-ld";
import { pageMeta } from "../../_content/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return COMPETITORS.map((c) => ({ anbieter: c.slug }));
}

export async function generateMetadata({ params }: PageProps<"/vergleich/[anbieter]">): Promise<Metadata> {
  const c = competitorBySlug((await params).anbieter);
  if (!c) return {};
  return pageMeta({
    title: `PodoHero und ${c.name} im Vergleich`,
    description: `PodoHero und ${c.name} sachlich gegenübergestellt: Zielgruppe, Dokumentation, Abrechnung, TI, Kasse, Hygiene, Einstieg – mit Quellen von der Herstellerwebsite (Stand ${COMPARISON_STAND}).`,
    path: `/vergleich/${c.slug}`,
  });
}

function sourceRefs(row: CompareRow) {
  if (row.source === undefined) return [];
  return Array.isArray(row.source) ? row.source : [row.source];
}

function faqFor(c: Competitor) {
  return [
    [`Ist PodoHero eine Alternative zu ${c.name}?`, `Für Praxen, die eine Software ausschließlich für Podologie suchen und Wert auf Doku am iPad, Selbstzahler-Funktionen, Hygiene und Pflegeheime legen, kann PodoHero eine Alternative sein. Welche Software passt, hängt von Ihrer Praxis ab – vergleichen Sie die Angaben in der Tabelle und testen Sie selbst.`],
    [`Wie kommen meine Daten aus ${c.name} zu PodoHero?`, "PodoHero importiert Patientenlisten aus einer Excel-Vorlage mit Prüfbericht vor dem Import sowie Patientenexporte aus Doctolib (CSV). Ob und in welchem Format Ihr bisheriges Programm Daten exportiert, erfragen Sie bitte beim jeweiligen Anbieter."],
    ["Rechnet PodoHero direkt mit den Krankenkassen ab?", "Nein. Abrechnungsreife Verordnungen werden per Export an ein Abrechnungszentrum übergeben, das die Übermittlung nach § 302 SGB V übernimmt."],
    ["Woher stammen die Angaben?", `Alle Angaben zu ${c.name} stammen von den öffentlich zugänglichen Seiten des Herstellers (Stand ${COMPARISON_STAND}) und sind in der Tabelle mit Quelle verlinkt. „Nicht angegeben“ bedeutet: Auf den genannten Seiten haben wir dazu keine Angabe gefunden.`],
  ] as const;
}

export default async function CompetitorPage({ params }: PageProps<"/vergleich/[anbieter]">) {
  const c = competitorBySlug((await params).anbieter);
  if (!c) notFound();
  const trail = [
    { name: "Vergleich", path: "/vergleich" },
    { name: `PodoHero und ${c.name}`, path: `/vergleich/${c.slug}` },
  ];
  const faq = faqFor(c);
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <JsonLd data={[breadcrumbLd(trail), faqLd(faq)]} />
      <Breadcrumbs trail={trail} />
      <header className="mt-6 max-w-3xl">
        <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">PodoHero und {c.name} im Vergleich</h1>
        <p className="mt-4 text-lg text-muted">{c.summary}</p>
        <p className="mt-3 flex flex-wrap gap-2">
          <Badge tone="info">Stand: {COMPARISON_STAND}</Badge>
          <Badge tone="neutral">Angaben ohne Gewähr, Quelle: Herstellerwebsite</Badge>
        </p>
      </header>

      <section aria-labelledby="tabelle" className="mt-10">
        <h2 id="tabelle" className="font-display text-2xl font-semibold">Funktionen und Angaben im Überblick</h2>
        <div className="mt-4 overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
          <table className="w-full min-w-[720px] border-collapse text-left text-[15px]">
            <caption className="sr-only">Gegenüberstellung PodoHero und {c.name} (Angaben zu {c.name} laut Herstellerwebsite, Stand {COMPARISON_STAND})</caption>
            <thead>
              <tr className="bg-surface-2 text-sm">
                <th scope="col" className="w-[22%] px-4 py-3 font-semibold">Funktion</th>
                <th scope="col" className="w-[36%] px-4 py-3 font-semibold">PodoHero</th>
                <th scope="col" className="px-4 py-3 font-semibold">{c.name} <span className="font-normal text-muted">(laut Herstellerwebsite)</span></th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((row) => (
                <tr key={row.topic} className="border-t border-border align-top">
                  <th scope="row" className="px-4 py-3 font-medium">{row.topic}</th>
                  <td className="px-4 py-3">{row.podo}</td>
                  <td className="px-4 py-3 text-muted">
                    {row.vendor ?? <span className="italic">nicht angegeben</span>}
                    {sourceRefs(row).map((i) => (
                      <sup key={i} className="ml-1">
                        <a href={`#quelle-${i + 1}`} className="font-semibold text-primary hover:underline" aria-label={`Quelle ${i + 1}`}>[{i + 1}]</a>
                      </sup>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-muted">
          „Nicht angegeben“: Auf den unten genannten Seiten von {c.name} fanden wir dazu keine Angabe – die Funktion kann trotzdem vorhanden sein.
          Preise vergleichen wir hier bewusst nicht; aktuelle Preise finden Sie beim jeweiligen Anbieter bzw. unter{" "}
          <Link href="/preise" className="font-semibold text-primary hover:underline">Preise</Link>.
        </p>
      </section>

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="staerken" className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <h2 id="staerken" className="font-display text-xl font-semibold">Schwerpunkte von {c.name}</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] text-muted">
            {c.strengths.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </section>
        <section aria-labelledby="anders" className="rounded-[var(--radius-card)] border border-primary bg-surface p-6">
          <h2 id="anders" className="font-display text-xl font-semibold">Schwerpunkte von PodoHero</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px]">
            {c.podoDifferent.map((s) => <li key={s}>{s}</li>)}
          </ul>
          <Link href="/funktionen" className="mt-4 inline-block text-sm font-semibold text-primary hover:underline">Alle Funktionen mit Screenshots</Link>
        </section>
      </div>

      <div className="mt-12">
        <FaqList items={faq} />
      </div>

      <section className="mt-12 flex flex-col items-start gap-4 rounded-[24px] bg-primary px-6 py-8 text-on-primary sm:px-10 md:flex-row md:items-center">
        <div className="flex-1">
          <h2 className="font-display text-2xl font-semibold">PodoHero 30 Tage kostenlos testen</h2>
          <p className="mt-1 opacity-90">
            Keine Zahlungsdaten nötig, endet automatisch. Danach kostenlos weiter mit bis zu 20 Patient:innen (eingeschränkter Funktionsumfang,{" "}
            <Link href="/preise" className="underline">siehe Preise</Link>).
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">Kostenlos testen</LinkButton>
          <LinkButton href="/wechseln" variant="secondary" className="h-12 px-6 text-base">So gelingt der Wechsel</LinkButton>
        </div>
      </section>

      <section aria-labelledby="quellen" className="mt-12">
        <h2 id="quellen" className="font-display text-xl font-semibold">Quellen</h2>
        <ol className="mt-3 space-y-1.5 text-sm">
          {c.sources.map((s, i) => (
            <li key={s.url} id={`quelle-${i + 1}`} className="scroll-mt-24">
              [{i + 1}]{" "}
              <a href={s.url} rel="nofollow noopener noreferrer" target="_blank" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                {s.label} <ExternalLink size={14} aria-hidden />
              </a>{" "}
              <span className="text-muted">– abgerufen am {COMPARISON_RETRIEVED}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-muted">
          Angaben ohne Gewähr, Quelle: Herstellerwebsite, Stand: {COMPARISON_STAND}. {c.name} ist ein Produkt von {c.vendor}; Produkt- und Firmennamen
          werden nur zur Identifikation genannt und sind ggf. Marken ihrer Inhaber. PodoHero steht in keiner Verbindung zu {c.vendor}. Hinweise auf
          veraltete oder fehlerhafte Angaben korrigieren wir umgehend.
        </p>
      </section>
    </div>
  );
}
