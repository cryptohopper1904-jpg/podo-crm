import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  CalendarDays,
  Camera,
  Check,
  ClipboardList,
  HeartPulse,
  Lock,
  MessageSquare,
  Minus,
  Receipt,
  ServerCog,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { getAuth } from "@/lib/auth/session";
import { PRICE_NOTE, PUBLIC_PLANS } from "./_content/plans";

export const metadata = { title: { absolute: "PodoHero – Praxissoftware für Podologie" } };

const HIGHLIGHTS = [
  { id: "doku", icon: Camera, title: "Doku mit Fotos am Stuhl", text: "Leistungen antippen, Fußschema markieren, Fotos direkt aus der Kamera – verschlüsselt und unveränderbar." },
  { id: "akte", icon: HeartPulse, title: "Risiken immer sichtbar", text: "Diabetes, Blutverdünner, pAVK, MRSA und Allergien stehen im Kopf jeder Akte." },
  { id: "termine", icon: CalendarDays, title: "Kalender, der mitdenkt", text: "Dauer aus dem Leistungskatalog, Feiertage je Bundesland, Hausbesuche und Doppelbuchungsprüfung." },
  { id: "verordnungen", icon: ClipboardList, title: "Verordnungen im Griff", text: "Fristen-Ampel, Frequenz, Einheiten und Zuzahlung – mit Export für Ihr Abrechnungszentrum." },
  { id: "rechnungen", icon: Receipt, title: "Rechnungen & Gutscheine", text: "Lückenlose Nummernkreise, USt-Logik nach § 4 Nr. 14 UStG, Mischzahlung und Gutscheine mit Restwert." },
  { id: "kommunikation", icon: MessageSquare, title: "Kundschaft halten", text: "Erinnerungen, Rückholung und Kundenportal – nur mit Einwilligung und ohne medizinische Inhalte." },
] as const;

const SECURITY = [
  { icon: ServerCog, title: "Hosting in Deutschland", text: "Die PodoHero-Cloud läuft bei Hetzner in Deutschland." },
  { icon: Lock, title: "Verschlüsselt", text: "Fotos und Dokumente mit eigenem Schlüssel je Praxis." },
  { icon: ShieldCheck, title: "Doppelte Mandantentrennung", text: "In der Anwendung und per Row-Level-Security der Datenbank." },
  { icon: Sparkles, title: "Kein KI-Training", text: "Ihre Daten trainieren keine Modelle. KI nur mit AVV." },
] as const;

type Cell = true | false | string;
const COMPARISON: { topic: string; podo: Cell; typical: Cell }[] = [
  { topic: "Behandlungsdoku mit Fotos direkt am iPad/iPhone", podo: true, typical: "je nach Anbieter, oft per Upload" },
  { topic: "Pflichtfoto-Assistent für Nagelspangen", podo: true, typical: "selten" },
  { topic: "CRM: Rückholung, Erinnerungen, Kundenportal", podo: true, typical: "teilweise" },
  { topic: "Selbstzahler: Gutscheine, Mischzahlung, eigene Online-Buchung", podo: true, typical: "teilweise" },
  { topic: "Hygiene: Sterilgut-Chargen, Rückverfolgung, Gerätebuch", podo: true, typical: "teilweise" },
  { topic: "Praxisfinanzen: Fixkosten und Break-even", podo: true, typical: "selten" },
  { topic: "GKV-Abrechnung nach § 302 SGB V", podo: "über Abrechnungszentrum (Export)", typical: "oft direkt integriert" },
  { topic: "Telematikinfrastruktur (TI/KIM)", podo: "geplant", typical: "oft vorhanden" },
  { topic: "Verordnung per Foto auslesen (OCR)", podo: "geplant", typical: "teilweise vorhanden" },
];

function CellView({ value }: { value: Cell }) {
  if (value === true)
    return (
      <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
        <Check size={18} aria-hidden /> ja
      </span>
    );
  if (value === false)
    return (
      <span className="inline-flex items-center gap-1.5 text-muted">
        <Minus size={18} aria-hidden /> nein
      </span>
    );
  return <span className="text-muted">{value}</span>;
}

export default async function Landing() {
  let loggedIn = false;
  try {
    loggedIn = !!(await getAuth());
  } catch {
    // Datenbank nicht erreichbar: Website trotzdem anzeigen
  }
  if (loggedIn) redirect("/heute");

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <Badge tone="primary">Für Podologie-Praxen in Deutschland</Badge>
            <h1 className="mt-5 font-display text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
              Pflichtdoku, Termine und Kasse – <span className="text-primary">in einem System.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted">
              PodoHero ersetzt Excel-Listen, Papierakte und Fotos auf dem Privathandy. Gebaut für den Behandlungsstuhl am iPad, mit
              Risiko-Ampel, unveränderbarer Dokumentation und Rechnungen nach GoBD.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">
                Kostenlos testen <ArrowRight size={18} aria-hidden />
              </LinkButton>
              <LinkButton href="/funktionen" variant="secondary" className="h-12 px-6 text-base">Funktionen ansehen</LinkButton>
            </div>
            <p className="mt-4 text-sm text-muted">30 Tage kostenlos · keine Zahlungsdaten nötig · endet automatisch</p>
          </div>

          {/* Stilisierte Vorschau (keine echten Daten) */}
          <div aria-hidden className="relative">
            <div className="absolute -right-10 -top-10 size-64 rounded-full bg-primary-soft" />
            <div className="absolute -bottom-8 -left-6 size-40 rounded-full bg-accent-soft" />
            <div className="relative rounded-[24px] border border-border bg-surface p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="h-3 w-28 rounded-full bg-surface-2" />
                <div className="flex gap-1.5">
                  <span className="size-2.5 rounded-full bg-border-strong" />
                  <span className="size-2.5 rounded-full bg-border-strong" />
                  <span className="size-2.5 rounded-full bg-border-strong" />
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-soft-text">Diabetes</span>
                <span className="rounded-full bg-warn-soft px-3 py-1 text-xs font-semibold text-warn-soft-text">Blutverdünner</span>
                <span className="rounded-full bg-info-soft px-3 py-1 text-xs font-semibold text-info-soft-text">IWGDF 2</span>
              </div>
              <div className="mt-5 grid grid-cols-3 gap-2">
                {["PK", "ON", "TB"].map((c, i) => (
                  <div key={c} className={`rounded-xl border p-3 text-center text-sm font-semibold ${i === 0 ? "border-primary bg-primary-soft text-primary-soft-text" : "border-border"}`}>
                    {c}
                  </div>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-[1fr_1.2fr] gap-3">
                <div className="flex aspect-square items-center justify-center rounded-xl bg-surface-2">
                  <svg viewBox="0 0 60 90" className="h-4/5 text-border-strong" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 85c-8 0-11-9-11-22S10 30 20 20s22-4 22 10-3 20-3 30 4 25-6 25H18z" />
                    <circle cx="44" cy="12" r="4" />
                    <circle cx="52" cy="22" r="3" />
                    <circle cx="25" cy="38" r="3.5" className="fill-accent stroke-accent" />
                  </svg>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 rounded-xl border border-border p-2.5 text-sm">
                    <Camera size={16} className="text-primary" /> Foto vorher
                    <Check size={16} className="ml-auto text-primary" />
                  </div>
                  <div className="flex items-center gap-2 rounded-xl border border-border p-2.5 text-sm">
                    <Lock size={16} className="text-primary" /> Charge erfasst
                    <Check size={16} className="ml-auto text-primary" />
                  </div>
                  <div className="mt-auto rounded-xl bg-primary px-3 py-2.5 text-center text-sm font-semibold text-on-primary">Abschließen</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Highlights */}
      <section aria-labelledby="highlights" className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="highlights" className="font-display text-3xl font-semibold tracking-tight">Was PodoHero heute kann</h2>
          <p className="mt-2 max-w-2xl text-muted">Kein Funktionsversprechen für irgendwann: Hier steht, was eingebaut ist. Was noch fehlt, kennzeichnen wir auf der Funktionsseite.</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {HIGHLIGHTS.map(({ id, icon: Icon, title, text }) => (
              <Link key={id} href={`/funktionen#${id}`} className="group rounded-[var(--radius-card)] border border-border bg-bg p-6 transition-colors hover:border-primary">
                <span className="inline-flex size-11 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-text">
                  <Icon size={22} aria-hidden />
                </span>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-1.5 text-[15px] text-muted">{text}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                  Mehr dazu <ArrowRight size={16} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Vergleich */}
      <section aria-labelledby="vergleich" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="vergleich" className="font-display text-3xl font-semibold tracking-tight">Anders als typische Podologie-Software</h2>
        <p className="mt-2 max-w-3xl text-muted">
          Viele etablierte Programme sind stark bei Kassenabrechnung und Telematik. PodoHero setzt den Schwerpunkt auf mobile Doku, Kundenbindung
          und Selbstzahler – und sagt offen, was noch fehlt. Allgemeine Einordnung, kein Vergleich mit einem bestimmten Produkt.
        </p>
        <div className="mt-8 overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
          <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
            <caption className="sr-only">Funktionsvergleich PodoHero und typische Podologie-Software</caption>
            <thead>
              <tr className="bg-surface-2 text-sm">
                <th scope="col" className="px-4 py-3 font-semibold">Thema</th>
                <th scope="col" className="px-4 py-3 font-semibold">PodoHero</th>
                <th scope="col" className="px-4 py-3 font-semibold">Typische Podologie-Software</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.topic} className="border-t border-border">
                  <th scope="row" className="px-4 py-3 font-medium">{row.topic}</th>
                  <td className="px-4 py-3"><CellView value={row.podo} /></td>
                  <td className="px-4 py-3"><CellView value={row.typical} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Sicherheit */}
      <section aria-labelledby="sicherheit-kurz" className="bg-primary-soft text-primary-soft-text">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 id="sicherheit-kurz" className="font-display text-3xl font-semibold tracking-tight">Gesundheitsdaten verdienen mehr als ein Passwort</h2>
            <p className="mt-3">Wir beschreiben genau, was technisch umgesetzt ist – und was noch nicht.</p>
            <LinkButton href="/sicherheit" variant="primary" className="mt-6">Sicherheit im Detail</LinkButton>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2">
            {SECURITY.map(({ icon: Icon, title, text }) => (
              <li key={title} className="rounded-[var(--radius-card)] bg-surface p-5 text-text">
                <Icon size={22} aria-hidden className="text-primary" />
                <p className="mt-3 font-semibold">{title}</p>
                <p className="mt-1 text-sm text-muted">{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Preise */}
      <section aria-labelledby="preise-kurz" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="preise-kurz" className="font-display text-3xl font-semibold tracking-tight">Einfache Preise</h2>
            <p className="mt-2 text-muted">{PRICE_NOTE} Monatlich kündbar.</p>
          </div>
          <LinkButton href="/preise" variant="secondary">Alle Tarife</LinkButton>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PUBLIC_PLANS.map((p) => (
            <div key={p.id} className={`rounded-[var(--radius-card)] border p-5 ${p.highlight ? "border-primary bg-surface" : "border-border bg-surface"}`}>
              <p className="font-semibold">{p.name}</p>
              <p className="mt-2 font-display text-3xl font-bold">{p.price}</p>
              <p className="text-sm text-muted">{p.period}</p>
              <p className="mt-3 text-sm">{p.therapists}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Abschluss */}
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="flex flex-col items-start gap-6 rounded-[24px] bg-primary px-6 py-10 text-on-primary sm:px-10 md:flex-row md:items-center">
          <div className="flex-1">
            <h2 className="font-display text-3xl font-semibold tracking-tight">In zwei Minuten startklar</h2>
            <p className="mt-2 opacity-90">Praxis anlegen, Leistungskatalog übernehmen, Excel-Liste importieren. Schnittstellen starten im Testmodus.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">Kostenlos testen</LinkButton>
            <LinkButton href="/login" variant="secondary" className="h-12 px-6 text-base">
              Anmelden
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}
