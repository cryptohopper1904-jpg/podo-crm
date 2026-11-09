import { Check } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { ADDONS, PRICE_NOTE, PUBLIC_PLANS } from "../_content/plans";

export const metadata = {
  title: "Preise",
  description: "PodoHero-Tarife: 30 Tage kostenlos testen, Starter 59 €, Praxis 99 €, Plus 149 € pro Monat (zzgl. USt., vorläufig).",
};

const INCLUDED = [
  "Kundenakte, Kalender, Behandlungsdoku mit Fotos",
  "Rechnungen, Quittungen, Gutscheine, Auswertungen",
  "Verordnungen mit Export für das Abrechnungszentrum",
  "Erinnerungen, Kundenportal, Online-Buchung",
  "Hygiene, Gerätebuch, Pflegeheime, Team",
  "Vollständiger Datenexport jederzeit",
  "Hosting in Deutschland, verschlüsselte Datensicherung",
];

const FAQ = [
  ["Was passiert nach der Testphase?", "Die Testphase endet nach 30 Tagen automatisch. Es wird nichts berechnet, solange Sie keinen Tarif buchen."],
  ["Kann ich monatlich kündigen?", "Ja. Vor der Löschung erstellen Sie einen vollständigen Export Ihrer Daten – Ihre Aufbewahrungspflichten bleiben bestehen."],
  ["Sind Drittanbieter enthalten?", "Nein. Kartenzahlung, Buchhaltung, SMS, WhatsApp oder KI-Anbieter rechnen ihre Leistungen selbst mit Ihnen ab."],
] as const;

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <header className="max-w-3xl">
        <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">Preise</h1>
        <p className="mt-4 text-lg text-muted">Ein Preis je Praxisgröße, monatlich kündbar.</p>
        <p className="mt-3"><Badge tone="warn">{PRICE_NOTE}</Badge></p>
      </header>

      <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {PUBLIC_PLANS.map((p) => (
          <section
            key={p.id}
            aria-labelledby={`plan-${p.id}`}
            className={`flex flex-col rounded-[var(--radius-card)] border bg-surface p-6 ${p.highlight ? "border-2 border-primary" : "border-border"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id={`plan-${p.id}`} className="font-display text-xl font-semibold">{p.name}</h2>
              {p.highlight ? <Badge tone="primary">beliebt für Teams</Badge> : null}
            </div>
            <p className="mt-4">
              <span className="font-display text-4xl font-bold">{p.price}</span>
              <span className="ml-1 text-muted">{p.period}</span>
            </p>
            {p.id !== "trial" ? <p className="text-xs text-muted">zzgl. USt.</p> : null}
            <p className="mt-4 font-medium">{p.therapists}</p>
            {p.note ? <p className="mt-1 text-sm text-muted">{p.note}</p> : null}
            <div className="mt-auto pt-6">
              <LinkButton href="/einrichtung" variant={p.highlight ? "accent" : "secondary"} className="w-full">
                {p.id === "trial" ? "Kostenlos testen" : "Mit Test starten"}
              </LinkButton>
            </div>
          </section>
        ))}
      </div>

      <section aria-labelledby="zusatzmodule" className="mt-12">
        <h2 id="zusatzmodule" className="font-display text-2xl font-semibold">Zusatzmodule</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {ADDONS.map((a) => (
            <section key={a.id} aria-labelledby={`addon-${a.id}`} className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id={`addon-${a.id}`} className="font-display text-xl font-semibold">{a.name}</h3>
                <Badge tone="warn">vorläufig</Badge>
              </div>
              <p className="mt-2 text-[15px] text-muted">{a.description}</p>
              <p className="mt-3 font-semibold">{a.pricing}</p>
            </section>
          ))}
        </div>
      </section>

      <section aria-labelledby="inklusive" className="mt-12 rounded-[var(--radius-card)] border border-border bg-surface p-6">
        <h2 id="inklusive" className="font-display text-2xl font-semibold">In jedem Tarif enthalten</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {INCLUDED.map((t) => (
            <li key={t} className="flex gap-2.5 text-[15px]">
              <Check size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" /> {t}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">Tarifinhalte und Preise sind vorläufig und können sich bis zum offiziellen Start ändern.</p>
      </section>

      <section aria-labelledby="faq" className="mt-12">
        <h2 id="faq" className="font-display text-2xl font-semibold">Häufige Fragen</h2>
        <div className="mt-4 flex flex-col gap-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group rounded-[var(--radius-card)] border border-border bg-surface p-5">
              <summary className="cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden">
                <span className="mr-2 inline-block text-primary transition-transform group-open:rotate-90" aria-hidden>›</span>
                {q}
              </summary>
              <p className="mt-3 text-[15px] text-muted">{a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
