import { CalendarSync, Check, FileSpreadsheet, ShieldCheck, Upload } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { Breadcrumbs, FaqList } from "../_content/faq-list";
import { breadcrumbLd, faqLd, JsonLd } from "../_content/json-ld";
import { pageMeta } from "../_content/site";
import { ScreenshotFrame } from "../_content/screenshot-frame";
import { SHOTS } from "../_content/screenshots";

export const dynamic = "force-static";

export const metadata = pageMeta({
  title: "Wechseln zu PodoHero",
  description:
    "Von Excel, Doctolib oder einer anderen Praxissoftware zu PodoHero wechseln: Import mit Prüfbericht, Doctolib-CSV und Kalender-Abo, Checkliste und Antworten auf häufige Fragen.",
  path: "/wechseln",
});

const PATHS = [
  {
    icon: FileSpreadsheet,
    title: "Excel-Import mit Prüfbericht",
    text: "Die Excel-Vorlage „Podologie Rechnungsmanager“ wird vollständig übernommen: Patient:innen, Leistungen, Gutscheine, Rechnungen und Fixkosten. Alte Rechnungen behalten ihre Nummer, die Nummernkreise laufen danach lückenlos weiter. Zuerst prüfen, dann importieren – bei einem Fehler wird alles zurückgenommen.",
  },
  {
    icon: Upload,
    title: "Doctolib-Patientenliste (CSV)",
    text: "Den Patientenexport aus Doctolib als CSV hochladen. Bereits importierte Personen (gleiche Doctolib-ID) werden übersprungen. Umgekehrt gibt es einen Export im Doctolib-Importformat.",
  },
  {
    icon: CalendarSync,
    title: "Doctolib-Termine per Kalender-Abo",
    text: "Doctolib bietet keine offene Schnittstelle. Mit einem Synchronisationsdienst wie Docal.io oder CalMedi landen Ihre Doctolib-Buchungen in einem Google-Kalender; PodoHero liest ihn über die private iCal-Adresse etwa alle 5 Minuten – nur lesend, Termine werden nie automatisch einer Akte zugeordnet. (Testmodus)",
  },
] as const;

const STEPS = [
  ["Testzugang anlegen", "Praxis registrieren – 30 Tage kostenlos, ohne Zahlungsdaten. Der Einrichtungsassistent führt durch Praxisdaten, Leistungen und Team."],
  ["Leistungskatalog prüfen", "Die Podologie-Vorlage übernehmen und Preise, Dauer und Steuersatz an Ihre Praxis anpassen."],
  ["Daten importieren", "Excel-Vorlage oder Doctolib-CSV hochladen, den Prüfbericht lesen, dann importieren."],
  ["Parallelbetrieb kurz halten", "Ab einem Stichtag neue Termine und Doku nur noch in PodoHero führen. Alte Software bis zum Ende Ihrer Aufbewahrungspflichten lesend behalten oder vollständig exportieren."],
  ["Team einladen", "Rollen vergeben (Inhaber:in, Podolog:in, Empfang, Azubi, Steuerberatung) und Zwei-Faktor-Anmeldung einrichten."],
  ["Schnittstellen nach Bedarf", "Kartenzahlung, SMS, Buchhaltung oder Kalender-Abo zunächst im Testmodus ausprobieren; Echtbetrieb mit Ihrem eigenen Vertrag beim Anbieter."],
] as const;

const CHECKLIST = [
  "Patientenliste aus der bisherigen Software oder Excel exportiert",
  "Leistungen und Preise (inkl. Steuersatz) zur Hand",
  "Offene Rechnungen und Gutscheine notiert",
  "Laufende GKV-Verordnungen mit verbrauchten Einheiten notiert",
  "Stichtag für den Umstieg festgelegt und dem Team mitgeteilt",
  "Aufbewahrung der Altdaten geklärt (Behandlungsdoku 10 Jahre nach § 630f BGB, Buchungsbelege nach § 147 AO)",
  "Auftragsverarbeitungsvertrag (AVV) bei der Registrierung abgeschlossen",
  "Patient:innen über neue Online-Buchung bzw. Patientenportal informiert",
] as const;

const FAQ = [
  ["Was kostet der Wechsel?", "Der Import ist in allen Tarifen enthalten (im kostenlosen Tarif bis 20 Patient:innen). Sie können 30 Tage kostenlos testen; danach wählen Sie einen Tarif oder nutzen den kostenlosen Tarif (1 Behandler:in, bis 20 Patient:innen, ohne Zeitlimit)."],
  ["Kann ich Daten aus jeder Praxissoftware importieren?", "Direkt eingelesen werden die Excel-Vorlage „Podologie Rechnungsmanager“ und die Doctolib-Patientenliste (CSV). Aus anderen Programmen exportieren Sie die Patientenliste und übertragen sie in die Excel-Vorlage. Welche Exporte Ihr bisheriges Programm anbietet, erfahren Sie beim jeweiligen Anbieter."],
  ["Werden Behandlungsdokumentationen und Fotos übernommen?", "Ein automatischer Import alter Behandlungsdokumentation ist nicht vorgesehen. Bewahren Sie die alte Dokumentation für die gesetzliche Frist auf – lesend im alten System oder als vollständiger Export."],
  ["Was passiert mit Doctolib?", "Sie können Doctolib parallel weiter nutzen: Termine kommen über das Kalender-Abo zu PodoHero, Patientenlisten per CSV. Zusätzlich bietet PodoHero eine eigene Online-Buchung und ein Patientenportal."],
  ["Kann ich PodoHero wieder verlassen?", "Ja, monatlich kündbar. Vor der Löschung erstellen Sie einen vollständigen Export Ihrer Daten."],
  ["Wo liegen meine Daten?", "Die PodoHero-Cloud läuft bei Hetzner in Deutschland. Fotos und Dokumente werden mit einem eigenen Schlüssel je Praxis verschlüsselt."],
] as const;

export default function SwitchPage() {
  const trail = [{ name: "Wechseln zu PodoHero", path: "/wechseln" }];
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <JsonLd data={[breadcrumbLd(trail), faqLd(FAQ)]} />
      <Breadcrumbs trail={trail} />
      <div className="mt-6 grid items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
        <header>
          <Badge tone="primary">Gebaut nur für Podologie</Badge>
          <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">Wechseln zu PodoHero</h1>
          <p className="mt-4 text-lg text-muted">
            Von Excel-Listen, Doctolib oder einer anderen Praxissoftware: Importieren Sie Ihre Patient:innen mit Prüfbericht, übernehmen Sie
            Doctolib-Termine automatisch und starten Sie ohne Risiko.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">30 Tage kostenlos testen</LinkButton>
            <LinkButton href="/preise" variant="secondary" className="h-12 px-6 text-base">Kostenloser Tarif</LinkButton>
          </div>
          <p className="mt-3 text-sm text-muted">Keine Zahlungsdaten nötig · endet automatisch · monatlich kündbar</p>
        </header>
        <ScreenshotFrame shot={SHOTS.akte} sizes="(min-width: 1024px) 560px, 100vw" eager />
      </div>

      <section aria-labelledby="wege" className="mt-14">
        <h2 id="wege" className="font-display text-2xl font-semibold">So kommen Ihre Daten zu PodoHero</h2>
        <ul className="mt-4 grid gap-4 md:grid-cols-3">
          {PATHS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-text"><Icon size={20} aria-hidden /></span>
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1 text-[15px] text-muted">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ablauf" className="mt-14">
        <h2 id="ablauf" className="font-display text-2xl font-semibold">Der Ablauf in sechs Schritten</h2>
        <ol className="mt-6 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="flex gap-4">
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-display font-bold text-on-primary">{i + 1}</span>
              <div>
                <h3 className="font-semibold leading-9">{t}</h3>
                <p className="text-[15px] text-muted">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="checkliste" className="mt-14 rounded-[var(--radius-card)] border border-border bg-surface p-6">
        <h2 id="checkliste" className="font-display text-2xl font-semibold">Checkliste für den Umstieg</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {CHECKLIST.map((t) => (
            <li key={t} className="flex gap-2.5 text-[15px]"><Check size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" /> {t}</li>
          ))}
        </ul>
        <p className="mt-4 flex gap-2 text-sm text-muted">
          <ShieldCheck size={18} aria-hidden className="shrink-0 text-primary" />
          Hochgeladene Importdateien werden nur im Arbeitsspeicher verarbeitet und nicht gespeichert.
        </p>
      </section>

      <div className="mt-14">
        <FaqList items={FAQ} />
      </div>

      <section className="mt-12 flex flex-col items-start gap-4 rounded-[24px] bg-primary px-6 py-8 text-on-primary sm:px-10 md:flex-row md:items-center">
        <div className="flex-1">
          <h2 className="font-display text-2xl font-semibold">Jetzt wechseln – ohne Risiko</h2>
          <p className="mt-1 opacity-90">30 Tage alle Funktionen testen. Danach kostenlos weiter mit bis zu 20 Patient:innen oder Tarif wählen.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <LinkButton href="/einrichtung" variant="accent" className="h-12 px-6 text-base">Kostenlos testen</LinkButton>
          <LinkButton href="/vergleich" variant="secondary" className="h-12 px-6 text-base">Vergleich ansehen</LinkButton>
        </div>
      </section>
    </div>
  );
}
