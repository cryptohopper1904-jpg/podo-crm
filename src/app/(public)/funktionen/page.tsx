import { Check, Clock, FlaskConical } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { FEATURE_GROUPS, STATUS_LABEL, type FeatureStatus } from "../_content/features";

export const metadata = {
  title: "Funktionen",
  description: "Patientenakte, Behandlungsdoku mit Fotos, Termine, Verordnungen, Rechnungen, Erinnerungen, Hygiene und Team – was PodoHero heute kann.",
};

function StatusIcon({ status = "live" }: { status?: FeatureStatus }) {
  if (status === "test") return <FlaskConical size={18} aria-hidden className="mt-0.5 shrink-0 text-info-soft-text" />;
  if (status === "planned") return <Clock size={18} aria-hidden className="mt-0.5 shrink-0 text-muted" />;
  return <Check size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" />;
}

export default function FeaturesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <header className="max-w-3xl">
        <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">Funktionen</h1>
        <p className="mt-4 text-lg text-muted">
          Alles, was eine Podologie-Praxis im Alltag braucht – vom Behandlungsstuhl bis zur Abrechnung. Wir kennzeichnen ehrlich, was im
          Testmodus läuft und was noch geplant ist.
        </p>
        <ul className="mt-6 flex flex-wrap gap-2 text-sm" aria-label="Legende">
          <li><Badge tone="primary"><Check size={14} aria-hidden className="mr-1" /> {STATUS_LABEL.live}</Badge></li>
          <li><Badge tone="info"><FlaskConical size={14} aria-hidden className="mr-1" /> {STATUS_LABEL.test}</Badge></li>
          <li><Badge tone="neutral"><Clock size={14} aria-hidden className="mr-1" /> {STATUS_LABEL.planned}</Badge></li>
        </ul>
      </header>

      <nav aria-label="Bereiche" className="mt-10 flex flex-wrap gap-2">
        {FEATURE_GROUPS.map((g) => (
          <a key={g.id} href={`#${g.id}`} className="rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold hover:border-primary">
            {g.title}
          </a>
        ))}
      </nav>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        {FEATURE_GROUPS.map((g) => (
          <section key={g.id} id={g.id} aria-labelledby={`${g.id}-t`} className="scroll-mt-24 rounded-[var(--radius-card)] border border-border bg-surface p-6">
            <h2 id={`${g.id}-t`} className="font-display text-2xl font-semibold">{g.title}</h2>
            <p className="mt-1 text-muted">{g.lead}</p>
            <ul className="mt-5 flex flex-col gap-3">
              {g.items.map((it) => (
                <li key={it.text} className="flex gap-2.5 text-[15px]">
                  <StatusIcon status={it.status} />
                  <span>
                    {it.text}
                    {it.status && it.status !== "live" ? <span className="sr-only"> ({STATUS_LABEL[it.status]})</span> : null}
                    {it.status === "planned" ? <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-muted" aria-hidden>geplant</span> : null}
                    {it.status === "test" ? <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-info-soft-text" aria-hidden>Testmodus</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="mt-12 rounded-[var(--radius-card)] border border-border bg-surface-2 p-6">
        <h2 className="font-display text-xl font-semibold">Was „Testmodus“ bedeutet</h2>
        <p className="mt-2 text-[15px] text-muted">
          Schnittstellen zu Diensten wie Kartenzahlung, Buchhaltung, SMS, WhatsApp oder KI sind fertig eingebaut, senden aber keine Daten, solange
          kein Vertrag mit dem Anbieter hinterlegt ist. KI-Funktionen werden für Gesundheitsdaten erst freigeschaltet, wenn ein EU-Anbieter mit
          Auftragsverarbeitungsvertrag und ohne Datenspeicherung bestätigt ist. KI-Ergebnisse sind Dokumentationshilfen, keine Diagnose.
        </p>
      </section>

      <div className="mt-12 flex flex-wrap gap-3">
        <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">Kostenlos testen</LinkButton>
        <LinkButton href="/preise" variant="secondary" className="h-12 px-6 text-base">Preise ansehen</LinkButton>
      </div>
    </div>
  );
}
