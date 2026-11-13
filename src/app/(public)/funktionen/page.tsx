import { Check, Clock, FlaskConical } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { FEATURE_GROUPS, STATUS_LABEL, type FeatureStatus } from "../_content/features";
import { breadcrumbLd, JsonLd } from "../_content/json-ld";
import { DemoDataNote, ScreenshotFrame } from "../_content/screenshot-frame";
import { FEATURE_SHOTS } from "../_content/screenshots";
import { pageMeta } from "../_content/site";

export const metadata = pageMeta({
  title: "Funktionen mit Screenshots",
  description:
    "Was PodoHero heute kann – mit echten Screenshots: Patientenakte, Doku mit Fußschema und 3D-Modell am iPad, Termine und Patientenportal, Verordnungen, Rechnungen und Kasse, Hygiene, Pflegeheime und Touren.",
  path: "/funktionen",
});

function StatusIcon({ status = "live" }: { status?: FeatureStatus }) {
  if (status === "test") return <FlaskConical size={18} aria-hidden className="mt-0.5 shrink-0 text-info-soft-text" />;
  if (status === "planned") return <Clock size={18} aria-hidden className="mt-0.5 shrink-0 text-muted" />;
  return <Check size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" />;
}

export default function FeaturesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <JsonLd data={breadcrumbLd([{ name: "Funktionen", path: "/funktionen" }])} />
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

      <div className="mt-10 flex flex-col gap-8">
        {FEATURE_GROUPS.map((g, gi) => {
          const shots = FEATURE_SHOTS[g.id] ?? [];
          return (
            <section
              key={g.id}
              id={g.id}
              aria-labelledby={`${g.id}-t`}
              className="scroll-mt-24 rounded-[var(--radius-card)] border border-border bg-surface p-6 sm:p-8"
            >
              <div className={`grid items-start gap-8 ${shots.length ? "lg:grid-cols-[1fr_1.25fr]" : ""}`}>
                <div className={gi % 2 && shots.length ? "lg:order-2" : ""}>
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
                </div>
                {shots.length ? (
                  <div className={`grid gap-6 ${shots.length > 1 ? "sm:grid-cols-2" : ""} ${gi % 2 ? "lg:order-1" : ""}`}>
                    {shots.map((shot, i) => (
                      <ScreenshotFrame
                        key={shot.src}
                        shot={shot}
                        className={shots.length > 1 && i === 0 && shot.device !== "phone" ? "sm:col-span-2" : ""}
                        sizes={shots.length > 1 && i > 0 ? "(min-width: 1024px) 300px, (min-width: 640px) 50vw, 100vw" : "(min-width: 1024px) 620px, 100vw"}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      <DemoDataNote className="mt-4" />

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
