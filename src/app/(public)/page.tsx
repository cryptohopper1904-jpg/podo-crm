import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Building2,
  CalendarCheck,
  Camera,
  ChartColumn,
  Check,
  ClipboardList,
  CreditCard,
  Footprints,
  HeartPulse,
  KeyRound,
  Lock,
  MessagesSquare,
  Minus,
  PhoneCall,
  Receipt,
  Repeat,
  ServerCog,
  ShieldCheck,
  Sparkles,
  SprayCan,
  type LucideIcon,
} from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { getAuth } from "@/lib/auth/session";
import { HeroCollage } from "./_content/hero-collage";
import { PRICE_NOTE, PUBLIC_PLANS } from "./_content/plans";

export const metadata = { title: { absolute: "PodoHero – Praxissoftware für Podologie" } };

type Capability = { icon: LucideIcon; title: string; text: string; href: string; test?: boolean };

/** „Alles drin“: nur, was laut docs/STATUS.md eingebaut ist. test = eingebaut, Echtbetrieb mit eigenem Anbietervertrag. */
const CAPABILITIES: { group: string; items: Capability[] }[] = [
  {
    group: "Behandlung",
    items: [
      { icon: Camera, title: "Doku mit Fotos am Stuhl", text: "Leistungen antippen, Fotos direkt aus der Kamera, unveränderbar gespeichert.", href: "/funktionen#doku" },
      { icon: Footprints, title: "Fuß in 2D und 3D", text: "Befunde im Fußschema oder am 3D-Modell markieren.", href: "/funktionen#doku" },
      { icon: HeartPulse, title: "Risiko-Ampel", text: "Diabetes, Blutverdünner, pAVK, MRSA – im Kopf jeder Akte.", href: "/funktionen#akte" },
    ],
  },
  {
    group: "Termine & Kommunikation",
    items: [
      { icon: CalendarCheck, title: "Online-Buchung & Kundenportal", text: "Patient:innen buchen und verschieben selbst, auch über Ihre Praxis-Website.", href: "/funktionen#termine" },
      { icon: PhoneCall, title: "KI-Telefonassistent", text: "Nimmt Anrufe an, nennt freie Zeiten, notiert Termin- und Rückrufwünsche.", href: "/funktionen#kommunikation", test: true },
      { icon: MessagesSquare, title: "Ein Posteingang", text: "E-Mail, WhatsApp und SMS an einem Ort, mit KI-Antwortvorschlägen.", href: "/funktionen#kommunikation", test: true },
      { icon: Repeat, title: "Erinnerung & Warteliste", text: "Automatische Erinnerungen, Rückholung und Nachrücker bei Absagen.", href: "/funktionen#termine" },
    ],
  },
  {
    group: "Abrechnung & Kasse",
    items: [
      { icon: CreditCard, title: "Rechnungen & Kartenzahlung", text: "GoBD-feste Nummernkreise, Gutscheine, SumUp-Terminal und Zahlungslink.", href: "/funktionen#rechnungen" },
      { icon: Receipt, title: "Kasse mit TSE", text: "Kassenbuch, Z-Bon und DSFinV-K-Export, TSE-Signatur über fiskaly.", href: "/funktionen#rechnungen" },
      { icon: ClipboardList, title: "GKV-Verordnungen", text: "Fristen-Ampel, Einheiten, Export ans Abrechnungszentrum, KIM vorbereitet.", href: "/funktionen#verordnungen" },
    ],
  },
  {
    group: "Praxisbetrieb",
    items: [
      { icon: SprayCan, title: "Hygiene & Gerätebuch", text: "Sterilgut-Chargen mit Rückverfolgung, Prüffristen, Tages-Checkliste.", href: "/funktionen#praxis" },
      { icon: Building2, title: "Pflegeheim-Modus", text: "Besuchstag mit Schnell-Doku und Sammelrechnung je Monat.", href: "/funktionen#praxis" },
      { icon: ChartColumn, title: "Auswertung & Break-even", text: "Umsatz, Behandlungen und Fixkosten – wann sich der Monat trägt.", href: "/funktionen#praxis" },
    ],
  },
];

const DAY: { time: string; title: string; text: string }[] = [
  { time: "7:45", title: "Praxis öffnen", text: "Hygiene-Checkliste abhaken, Sterilgut-Charge freigeben. Der Tagesüberblick zeigt Termine und neue Nachrichten." },
  { time: "9:00", title: "Am Behandlungsstuhl", text: "Risiken sind sofort sichtbar. Leistungen antippen, Befund am Fuß markieren, Fotos aufnehmen – fertig dokumentiert." },
  { time: "11:30", title: "Während Sie behandeln", text: "Der Telefonassistent nimmt Anrufe an und legt Terminwünsche zur Bestätigung ab. Eine Absage? Die Warteliste bietet den Termin automatisch an." },
  { time: "14:00", title: "Hausbesuch im Pflegeheim", text: "Bewohnerliste öffnen, Schnell-Doku je Person. Die Sammelrechnung entsteht am Monatsende von selbst." },
  { time: "17:30", title: "Abrechnen", text: "Rechnung mit Karte über SumUp bezahlen lassen, Verordnungen abrechnungsreif setzen und für das Abrechnungszentrum exportieren." },
  { time: "18:30", title: "Feierabend", text: "Tagesabschluss mit Z-Bon. Die Erinnerungen für morgen gehen automatisch raus – nur an Personen mit Einwilligung." },
];

const SECURITY = [
  { icon: ServerCog, title: "Hosting in Deutschland", text: "Die PodoHero-Cloud läuft bei Hetzner in Deutschland." },
  { icon: Lock, title: "Verschlüsselt", text: "Fotos und Dokumente mit eigenem Schlüssel je Praxis." },
  { icon: ShieldCheck, title: "Doppelte Mandantentrennung", text: "In der Anwendung und per Row-Level-Security der Datenbank." },
  { icon: Sparkles, title: "Kein KI-Training", text: "Ihre Daten trainieren keine Modelle. KI nur mit AVV." },
  { icon: KeyRound, title: "Zwei-Faktor-Anmeldung", text: "Pflicht für Inhaber:innen, auf Wunsch für das ganze Team." },
  { icon: Lock, title: "Unveränderbare Doku", text: "Einträge und Kassenabschlüsse in einer prüfbaren Hash-Kette." },
] as const;

type Cell = true | false | string;
const COMPARISON: { topic: string; podo: Cell; typical: Cell }[] = [
  { topic: "Behandlungsdoku mit Fotos direkt am iPad/iPhone", podo: true, typical: "je nach Anbieter, oft per Upload" },
  { topic: "Pflichtfoto-Assistent für Nagelspangen", podo: true, typical: "selten" },
  { topic: "CRM: Rückholung, Erinnerungen, Kundenportal mit Selbstbuchung", podo: true, typical: "teilweise" },
  { topic: "KI-Telefonassistent für Terminwünsche", podo: "eingebaut (Testmodus)", typical: "selten" },
  { topic: "Selbstzahler: Gutscheine, Mischzahlung, eigene Online-Buchung", podo: true, typical: "teilweise" },
  { topic: "Hygiene: Sterilgut-Chargen, Rückverfolgung, Gerätebuch", podo: true, typical: "teilweise" },
  { topic: "Praxisfinanzen: Fixkosten und Break-even", podo: true, typical: "selten" },
  { topic: "GKV-Abrechnung nach § 302 SGB V", podo: "über Abrechnungszentrum (Export)", typical: "oft direkt integriert" },
  { topic: "Telematikinfrastruktur (TI/KIM)", podo: "KIM vorbereitet, Echtbetrieb mit eigenen TI-Komponenten", typical: "oft vorhanden" },
  { topic: "Verordnung per Foto auslesen", podo: "eingebaut (Testmodus, Felder werden bestätigt)", typical: "teilweise vorhanden" },
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
      <section aria-labelledby="hero-title" className="relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-12 pt-12 sm:px-6 md:pt-16 lg:grid-cols-[1fr_1.05fr] lg:gap-8 lg:pb-16">
          <div>
            <Badge tone="primary">Praxissoftware für Podologie in Deutschland</Badge>
            <h1 id="hero-title" className="mt-5 font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.6rem]">
              Ihre Praxis läuft.{" "}<span className="block text-primary">Sie behandeln.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted">
              PodoHero dokumentiert am Behandlungsstuhl, nimmt Anrufe an, füllt freie Termine nach, erinnert Ihre Kundschaft und schließt abends
              die Kasse. Eine Software für die ganze Praxis – vom ersten Anruf bis zum Z-Bon.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">
                Kostenlos testen <ArrowRight size={18} aria-hidden />
              </LinkButton>
              <LinkButton href="/funktionen" variant="secondary" className="h-12 px-6 text-base">Funktionen ansehen</LinkButton>
            </div>
            <p className="mt-4 text-sm text-muted">30 Tage kostenlos · keine Zahlungsdaten nötig · endet automatisch</p>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium" aria-label="Datenschutz">
              <li className="inline-flex items-center gap-1.5"><ServerCog size={16} aria-hidden className="text-primary" /> Hosting in Deutschland</li>
              <li className="inline-flex items-center gap-1.5"><Lock size={16} aria-hidden className="text-primary" /> Fotos verschlüsselt</li>
              <li className="inline-flex items-center gap-1.5"><KeyRound size={16} aria-hidden className="text-primary" /> Zwei-Faktor-Anmeldung</li>
            </ul>
          </div>

          {/* Stilisierte Vorschau mehrerer Funktionen (keine echten Daten) */}
          <HeroCollage />
        </div>
      </section>

      {/* Alles drin */}
      <section aria-labelledby="alles-drin" className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="alles-drin" className="font-display text-3xl font-semibold tracking-tight">Alles drin – nicht nur die Pflicht</h2>
              <p className="mt-2 max-w-2xl text-muted">
                Behandlung, Termine, Kommunikation, Abrechnung und Praxisbetrieb in einem System. Hier steht nur, was heute eingebaut ist.
              </p>
            </div>
            <Link href="/funktionen" className="inline-flex items-center gap-1 rounded-lg font-semibold text-primary hover:underline">
              Alle Funktionen <ArrowRight size={16} aria-hidden />
            </Link>
          </div>
          <div className="mt-10 grid gap-x-6 gap-y-10 md:grid-cols-2 xl:grid-cols-4">
            {CAPABILITIES.map(({ group, items }) => (
              <div key={group}>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">{group}</h3>
                <ul className="mt-3 flex flex-col gap-2">
                  {items.map(({ icon: Icon, title, text, href, test }) => (
                    <li key={title}>
                      <Link
                        href={href}
                        className="group flex gap-3 rounded-xl border border-transparent p-2.5 -mx-2.5 transition-colors hover:border-border hover:bg-bg"
                      >
                        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-text">
                          <Icon size={20} aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-x-2 font-semibold group-hover:text-primary">
                            {title}
                            {test ? (
                              <span className="rounded-full bg-info-soft px-2 py-px text-[11px] font-semibold text-info-soft-text">Testmodus</span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block text-sm text-muted">{text}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-10 text-sm text-muted">
            <span className="font-semibold text-text">Testmodus</span> heißt: fertig eingebaut, im Echtbetrieb mit Ihrem eigenen Vertrag beim
            jeweiligen Anbieter (z. B. Telefonie, SMS, Kartenzahlung, KI mit Auftragsverarbeitungsvertrag). KI-Ergebnisse sind Hilfen, keine Diagnose.
          </p>
        </div>
      </section>

      {/* Ein Tag mit PodoHero */}
      <section aria-labelledby="tag" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="tag" className="font-display text-3xl font-semibold tracking-tight">Ein Tag mit PodoHero</h2>
        <p className="mt-2 max-w-2xl text-muted">Vom Aufschließen bis zum Feierabend: So greifen die Bausteine im Praxisalltag ineinander.</p>
        <ol className="mt-10 grid gap-x-8 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
          {DAY.map((step, i) => (
            <li key={step.time} className="relative flex gap-4">
              <div className="flex flex-col items-center">
                <span className="inline-flex h-9 min-w-16 items-center justify-center rounded-full bg-primary px-3 font-display text-sm font-bold text-on-primary">
                  {step.time}
                </span>
                {i < DAY.length - 1 ? <span aria-hidden className="mt-2 w-px flex-1 bg-border-strong md:hidden" /> : null}
              </div>
              <div className="pb-1">
                <h3 className="text-lg font-semibold leading-9">{step.title}</h3>
                <p className="mt-1 text-[15px] text-muted">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Vergleich */}
      <section aria-labelledby="vergleich" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
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
