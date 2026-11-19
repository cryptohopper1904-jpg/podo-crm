import Link from "next/link";
import { ArrowLeftRight, CalendarSync, KeyRound, ScrollText } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { CONNECTOR_PRICES, CONNECTOR_STATUS_NOTE, CONNECTOR_TRADEMARK_NOTE } from "../_content/connector";
import { Breadcrumbs, FaqList } from "../_content/faq-list";
import { breadcrumbLd, faqLd, JsonLd } from "../_content/json-ld";
import { PRICE_NOTE } from "../_content/plans";
import { pageMeta } from "../_content/site";

export const metadata = pageMeta({
  title: "Connector für Doctolib (in Vorbereitung)",
  description:
    "Geplanter Connector: Doctolib-Termine direkt im PodoHero-Kalender oder im Google- und Outlook-Kalender. In Vorbereitung – startet erst mit einem von Doctolib freigegebenen Zugang.",
  path: "/connector-fuer-doctolib",
});

const POINTS = [
  {
    icon: CalendarSync,
    title: "Termine an einem Ort",
    text: "Buchungen aus Doctolib sollen ohne Umweg im PodoHero-Kalender erscheinen. Änderungen und Absagen sollen übernommen werden.",
  },
  {
    icon: ArrowLeftRight,
    title: "Abgleich in beide Richtungen",
    text: "Belegte Zeiten in PodoHero sollen den passenden Doctolib-Termin sperren, damit nichts doppelt vergeben wird. Doctolib soll für die Online-Buchung das führende System bleiben.",
  },
  {
    icon: KeyRound,
    title: "Kein Passwort bei uns",
    text: "Geplant ist ausschließlich ein von Doctolib freigegebener Zugang, den die Praxis selbst erteilt und jederzeit trennen kann. Wir fragen kein Doctolib-Passwort ab und lesen keine Oberfläche aus.",
  },
  {
    icon: ScrollText,
    title: "Nachvollziehbar",
    text: "Jeder Abgleich soll im Protokoll der Praxis stehen. Die Verarbeitung soll im Auftrag der Praxis auf Grundlage eines Auftragsverarbeitungsvertrags erfolgen.",
  },
] as const;

const FAQ = [
  ["Kann ich den Connector schon nutzen?", "Nein. Er ist in Vorbereitung und noch nicht buchbar. Voraussetzung ist ein von Doctolib freigegebener Schnittstellenzugang; ob und wann es ihn gibt, steht nicht fest."],
  ["Wie kommen Doctolib-Termine heute zu PodoHero?", "Über ein Kalender-Abo: Ein Synchronisationsdienst überträgt die Buchungen in einen Google-Kalender, PodoHero liest ihn über die private iCal-Adresse (nur lesend, Testmodus). Die Praxis bleibt verantwortlich und braucht eigene Auftragsverarbeitungsverträge mit diesen Diensten. Die Einzelheiten stehen unter „Wechseln zu PodoHero“."],
  ["Sind die Preise verbindlich?", "Nein. Es sind geplante, vorläufige Nettopreise. Sie können sich ändern, unter anderem durch Bedingungen von Doctolib."],
  ["Brauche ich PodoHero, um den Connector zu nutzen?", "Geplant sind zwei Wege: eingebaut in PodoHero und einzeln für den Abgleich mit Google- oder Outlook-Kalender. Ob das Einzelangebot kommt, hängt von den Bedingungen von Doctolib ab."],
  ["Ist PodoHero Partner von Doctolib?", "Nein. PodoHero ist ein unabhängiges Angebot."],
] as const;

export default function ConnectorPage() {
  const trail = [{ name: "Connector für Doctolib", path: "/connector-fuer-doctolib" }];
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <JsonLd data={[breadcrumbLd(trail), faqLd(FAQ)]} />
      <Breadcrumbs trail={trail} />
      <header className="mt-6 max-w-3xl">
        <Badge tone="warn">In Vorbereitung</Badge>
        <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">Geplant: Doctolib-Termine direkt in PodoHero</h1>
        <p className="mt-4 text-lg text-muted">
          Wir bereiten einen Connector vor, der den Doctolib-Kalender Ihrer Praxis mit PodoHero abgleichen soll – auf Wunsch auch mit einem Google- oder
          Outlook-Kalender.
        </p>
        <p className="mt-4 rounded-[var(--radius-card)] border border-border bg-surface p-4 text-[15px]">{CONNECTOR_STATUS_NOTE}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <LinkButton href="/wechseln" variant="accent" className="h-12 px-6 text-base">So geht es heute</LinkButton>
          <LinkButton href="/impressum" variant="secondary" className="h-12 px-6 text-base">Kontakt (Impressum)</LinkButton>
        </div>
      </header>

      <section aria-labelledby="geplant" className="mt-14">
        <h2 id="geplant" className="font-display text-2xl font-semibold">Was geplant ist</h2>
        <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {POINTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-text"><Icon size={20} aria-hidden /></span>
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1 text-[15px] text-muted">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="preise" className="mt-14">
        <h2 id="preise" className="font-display text-2xl font-semibold">Geplante Preise</h2>
        <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          {CONNECTOR_PRICES.map((p) => (
            <li key={p.name} className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
              <h3 className="font-semibold">{p.name}</h3>
              <p className="mt-2 font-display text-xl font-bold">{p.price}</p>
              <p className="mt-2 text-[15px] text-muted">{p.text}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">
          Geplante Preise, noch nicht buchbar. {PRICE_NOTE.replace(" (siehe unten).", ".")} Die Tarife von PodoHero stehen unter <Link href="/preise" className="underline">Preise</Link>.
        </p>
      </section>

      <div className="mt-14">
        <FaqList items={FAQ} />
      </div>

      <p className="mt-10 text-sm text-muted">{CONNECTOR_TRADEMARK_NOTE}</p>
    </div>
  );
}
