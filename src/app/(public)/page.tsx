import Link from "next/link";
import { ScrollArea } from "@/components/scroll-area";
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
  TabletSmartphone,
  Upload,
  FileSignature,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import { Badge, LinkButton } from "@/components/ui";
import { getAuth } from "@/lib/auth/session";
import { HeroShots } from "./_content/hero-shots";
import { ExplainerVideoPlayer } from "./_content/explainer-video-player";
import { EXPLAINER_VIDEO_NOTE } from "./_content/explainer-video";
import { faqLd, JsonLd, organizationLd, softwareApplicationLd, videoObjectLd } from "./_content/json-ld";
import { FaqList } from "./_content/faq-list";
import { PRICE_NOTE, PUBLIC_PLANS } from "./_content/plans";
import { DemoDataNote, ScreenshotFrame, ShotImage } from "./_content/screenshot-frame";
import { SHOTS, type Screenshot } from "./_content/screenshots";
import { OG_IMAGE } from "./_content/site";
import { TrialButton, TrialText } from "./_content/trial-cta";

const HOME_TITLE = "PodoHero – Praxissoftware für Podologie mit GKV-Abrechnung";
const HOME_DESCRIPTION =
  "Praxissoftware für Podologie: Terminplanung mit Online-Buchung, GKV-Verordnungen bis zur Abrechnung, Kasse mit Z-Bon, Doku am iPad. Hosting in Deutschland.";

export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: HOME_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: HOME_TITLE, description: HOME_DESCRIPTION, url: "/", type: "website", locale: "de_DE", siteName: "PodoHero", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: HOME_TITLE, description: HOME_DESCRIPTION, images: [OG_IMAGE.url] },
};

/** GKV-Abrechnung: nur, was laut docs/GKV.md umgesetzt ist. § 302-Direktabrechnung ist ausdrücklich nur in Vorbereitung. */
const GKV_POINTS = [
  "Verordnungsprüfung: Pflichtangaben, Fristen, Frequenz, Höchstmengen und Positionsnummern – mit Quelle zu jeder Regel",
  "Unterschrift der versicherten Person je Behandlung am Tablet oder Vermerk auf der Papier-Verordnung",
  "Leistungsnachweis als PDF, Therapiebericht und Vorlage zur Anforderung der Folgeverordnung",
  "Zuzahlungsquittung mit eigener Belegnummer, direkt in der Kasse gebucht",
  "Kennzeichen der Verordnungsart, Absetzungen und Retaxen, Korrektur abgerechneter Verordnungen",
  "Abrechnungslauf mit Export im neutralen Format für Ihr Abrechnungszentrum, Auswertung Kasse vs. privat und Belegliste",
] as const;

/** Kurze FAQ (sichtbar + FAQPage-JSON-LD) – Antworten müssen mit /funktionen, /sicherheit und docs/ übereinstimmen. */
const HOME_FAQ = [
  [
    "Kann ich mit PodoHero gesetzliche Krankenkassen abrechnen?",
    "Über ein Abrechnungszentrum: PodoHero prüft die Verordnungen, sammelt Unterschriften und Leistungsnachweise und stellt abrechnungsreife Verordnungen als Export im neutralen Format zur Weitergabe an Ihr Abrechnungszentrum bereit. Ob Ihr Zentrum das Format übernimmt, klären Sie bitte vorab; eine feste Partneranbindung besteht noch nicht. Die Übermittlung nach § 302 SGB V übernimmt das Zentrum.",
  ],
  [
    "Gibt es eine Direktabrechnung nach § 302 SGB V?",
    "Sie ist in Vorbereitung. Heute erzeugt PodoHero einen Prüflauf und eine Testdatei; der Versand an die Datenannahmestellen der Kassen ist noch nicht möglich, weil Verschlüsselung und Zertifikat fehlen. Bis dahin rechnen Sie über ein Abrechnungszentrum ab.",
  ],
  [
    "Hat die Kasse eine TSE?",
    "Noch nicht für den Echtbetrieb. Eingebaut sind Kassenbuch, Z-Bon und DSFinV-K-Export. Die TSE-Anbindung (fiskaly) ist in Vorbereitung – setzen Sie PodoHero vor dem Echtbetrieb der TSE noch nicht als elektronische Kasse ein.",
  ],
  [
    "Wo liegen die Gesundheitsdaten meiner Patient:innen?",
    "Die PodoHero-Cloud läuft bei Hetzner in Deutschland. Fotos, Dokumente und Unterschriften werden mit einem eigenen Schlüssel je Praxis verschlüsselt, die Praxen sind in Anwendung und Datenbank voneinander getrennt. Wir nutzen Ihre Daten nicht zum KI-Training; KI-Funktionen sind standardmäßig aus.",
  ],
  [
    "Kann ich meine Daten aus Pododesk übernehmen?",
    "Ja, für die Inhalte des Pododesk-Gesamtexports: Patient:innen, private Leistungen und Termine übernimmt der Übernahme-Assistent mit Vorschau. Behandlungsdokumentation, Verordnungen und Rechnungen sind nicht in diesem Export enthalten.",
  ],
] as const;

/** Live-Beispiele: echte Screens mit Demodaten, verlinkt auf die passende Funktion */
const LIVE: { shot: Screenshot; title: string; text: string; href: string; tag: string }[] = [
  { shot: SHOTS.fussschema, tag: "iPad", title: "Doku am Behandlungsstuhl", text: "Befunde im Fußschema antippen, je Stelle notieren, Sterilgut-Charge erfassen.", href: "/funktionen#doku" },
  { shot: SHOTS.besuchstag, tag: "iPad", title: "Besuchstag im Pflegeheim", text: "Je Bewohner:in Leistungen antippen und Kurzbefund speichern – Liste statt Einzelakten.", href: "/funktionen#praxis" },
  { shot: SHOTS.sammelrechnung, tag: "Desktop", title: "Sammelrechnung ans Pflegeheim", text: "Positionen kommen aus dem Besuchstag, Steuerbefreiung wird geprüft und vermerkt.", href: "/funktionen#rechnungen" },
  { shot: SHOTS.kasse, tag: "Desktop", title: "Kasse mit Z-Bon", text: "Bar, Karte, Gutschein – Kassenbuch, Zählprotokoll und lückenloser Tagesabschluss; TSE-Anbindung (fiskaly) in Vorbereitung.", href: "/funktionen#rechnungen" },
  { shot: SHOTS.hygiene, tag: "Desktop", title: "Hygiene & Gerätebuch", text: "Chargen freigeben, Fristen für Wartung und Validierung, Tages-Checkliste.", href: "/funktionen#praxis" },
  { shot: SHOTS.website, tag: "Website", title: "Ihre Praxis-Website", text: "Aus Ihren Praxisdaten erzeugt – mit „Termin online buchen“, ohne Cookies.", href: "/funktionen#termine" },
];

const ONLY_PODO = [
  "Fußschema in 2D und am 3D-Fußmodell",
  "Nagelspangen-Episoden mit Pflichtfoto-Assistent",
  "Risiko-Hinweise: erfasste Risikofaktoren wie Diabetes, Blutverdünner, pAVK, Neuropathie auf einen Blick",
  "Verordnungen DF, NF, QF und UI mit Fristen-Ampel",
  "Sterilgut-Chargen bis zur einzelnen Behandlung rückverfolgbar",
  "Pflegeheim-Modus, Touren und Sammelrechnung",
] as const;

type Capability = { icon: LucideIcon; title: string; text: string; href: string; test?: boolean; pilot?: boolean };

/** „Alles drin“: nur, was laut docs/STATUS.md eingebaut ist. test = eingebaut, Echtbetrieb mit eigenem Anbietervertrag. */
const CAPABILITIES: { group: string; items: Capability[] }[] = [
  {
    group: "Behandlung",
    items: [
      { icon: Camera, title: "Doku mit Fotos am Stuhl", text: "Leistungen antippen, Fotos direkt aus der Kamera, unveränderbar gespeichert.", href: "/funktionen#doku" },
      { icon: Footprints, title: "Fuß in 2D und 3D", text: "Befunde im Fußschema oder am 3D-Modell markieren.", href: "/funktionen#doku" },
      { icon: HeartPulse, title: "Risiko-Hinweise", text: "Zeigt die von Ihnen erfassten Risikofaktoren wie Diabetes, Blutverdünner, pAVK, MRSA im Kopf jeder Akte an.", href: "/funktionen#akte" },
    ],
  },
  {
    group: "Termine & Kommunikation",
    items: [
      { icon: CalendarCheck, title: "Online-Buchung & Patientenportal", text: "Patient:innen buchen und verschieben selbst, auch über Ihre Praxis-Website (Patientenportal ab Tarif Praxis).", href: "/funktionen#termine" },
      { icon: PhoneCall, title: "KI-Telefonassistent", text: "Soll Anrufe annehmen, freie Zeiten nennen und Termin- und Rückrufwünsche notieren.", href: "/funktionen#kommunikation", pilot: true },
      { icon: MessagesSquare, title: "Ein Posteingang", text: "E-Mail, WhatsApp und SMS an einem Ort, mit KI-Antwortvorschlägen.", href: "/funktionen#kommunikation", test: true },
      { icon: Repeat, title: "Erinnerung & Warteliste", text: "Automatische Erinnerungen, Rückholung und Nachrücker bei Absagen.", href: "/funktionen#termine" },
      { icon: TabletSmartphone, title: "iPad-Übergabe", text: "Patient:innen füllen die Anamnese selbst am iPad aus – die übrigen Praxisdaten bleiben gesperrt.", href: "/funktionen#doku" },
    ],
  },
  {
    group: "Abrechnung & Kasse",
    items: [
      { icon: CreditCard, title: "Rechnungen & Kartenzahlung", text: "Lückenlose Nummernkreise, Gutscheine; Kartenzahlung über SumUp-Terminal und Zahlungslink.", href: "/funktionen#rechnungen", test: true },
      { icon: Receipt, title: "Kasse mit Z-Bon", text: "Kassenbuch, Z-Bon und DSFinV-K-Export. TSE-Anbindung (fiskaly) in Vorbereitung – vor dem Echtbetrieb als elektronische Kasse noch nicht einsetzen.", href: "/funktionen#rechnungen" },
      { icon: ClipboardList, title: "GKV-Abrechnung", text: "Verordnungsprüfung, Unterschrift je Behandlung, Leistungsnachweis, Export im neutralen Format fürs Abrechnungszentrum.", href: "/funktionen#verordnungen" },
      { icon: FileSignature, title: "Zuzahlung & Retaxen", text: "Zuzahlungsquittung mit Kassenbuchung, Absetzungen verfolgen, Korrektur und Neuabrechnung.", href: "/funktionen#verordnungen" },
    ],
  },
  {
    group: "Praxisbetrieb",
    items: [
      { icon: SprayCan, title: "Hygiene & Gerätebuch", text: "Sterilgut-Chargen mit Rückverfolgung, Prüffristen, Tages-Checkliste.", href: "/funktionen#praxis" },
      { icon: Building2, title: "Pflegeheim-Modus", text: "Besuchstag mit Schnell-Doku und Sammelrechnung je Monat.", href: "/funktionen#praxis" },
      { icon: ChartColumn, title: "Auswertung & Break-even", text: "Umsatz, Behandlungen, Kasse vs. privat und Fixkosten – wann sich der Monat trägt.", href: "/funktionen#praxis" },
      { icon: Upload, title: "Übernahme aus Pododesk", text: "Patient:innen, Leistungen und Termine aus dem Gesamtexport – auch aus Tinana, Excel und Doctolib-CSV.", href: "/wechseln" },
    ],
  },
];

const DAY: { time: string; title: string; text: string }[] = [
  { time: "7:45", title: "Praxis öffnen", text: "Hygiene-Checkliste abhaken, Sterilgut-Charge freigeben. Der Tagesüberblick zeigt Termine und neue Nachrichten." },
  { time: "9:00", title: "Am Behandlungsstuhl", text: "Risiken sind sofort sichtbar. Leistungen antippen, Befund am Fuß markieren, Fotos aufnehmen – fertig dokumentiert." },
  { time: "11:30", title: "Während Sie behandeln", text: "Eine Absage? Die Warteliste bietet den Termin automatisch an. Ein KI-Telefonassistent für Terminwünsche ist als Pilot in Vorbereitung." },
  { time: "14:00", title: "Hausbesuch im Pflegeheim", text: "Bewohnerliste öffnen, Schnell-Doku je Person. Die Sammelrechnung entsteht am Monatsende von selbst." },
  { time: "17:30", title: "Abrechnen", text: "Rechnung mit Karte über SumUp bezahlen lassen, Verordnungen abrechnungsreif setzen und als Export für das Abrechnungszentrum bereitstellen." },
  { time: "18:30", title: "Feierabend", text: "Tagesabschluss mit Z-Bon. Die Erinnerungen für morgen gehen automatisch raus – nur an Personen mit Einwilligung." },
];

const SECURITY = [
  { icon: ServerCog, title: "Hosting in Deutschland", text: "Die PodoHero-Cloud läuft bei Hetzner in Deutschland." },
  { icon: Lock, title: "Verschlüsselt", text: "Fotos und Dokumente mit eigenem Schlüssel je Praxis." },
  { icon: ShieldCheck, title: "Doppelte Mandantentrennung", text: "In der Anwendung und per Row-Level-Security der Datenbank." },
  { icon: Sparkles, title: "Kein KI-Training mit Ihren Daten", text: "Wir nutzen Ihre Daten nicht zum KI-Training. KI-Funktionen sind standardmäßig aus; Sie wählen den Anbieter selbst und bestätigen AVV und Geheimhaltung." },
  { icon: KeyRound, title: "Zwei-Faktor-Anmeldung", text: "Pflicht für Inhaber:innen, auf Wunsch für das ganze Team." },
  { icon: Lock, title: "Unveränderbare Doku", text: "Einträge und Kassenabschlüsse in einer prüfbaren Hash-Kette." },
] as const;

type Cell = true | false | string;
const COMPARISON: { topic: string; podo: Cell }[] = [
  { topic: "Behandlungsdoku mit Fotos direkt am iPad/iPhone", podo: true },
  { topic: "Pflichtfoto-Assistent für Nagelspangen", podo: true },
  { topic: "CRM: Rückholung, Erinnerungen, Patientenportal mit Selbstbuchung", podo: "ja (Patientenportal ab Tarif Praxis)" },
  { topic: "KI-Telefonassistent für Terminwünsche", podo: "Pilot in Vorbereitung" },
  { topic: "Selbstzahler: Gutscheine, Mischzahlung, eigene Online-Buchung", podo: true },
  { topic: "Hygiene: Sterilgut-Chargen, Rückverfolgung, Gerätebuch", podo: true },
  { topic: "Praxisfinanzen: Fixkosten und Break-even", podo: true },
  { topic: "GKV-Abrechnung nach § 302 SGB V", podo: "Export im neutralen Format zur Weitergabe an ein Abrechnungszentrum (Format vorab mit dem Zentrum klären); Direktabrechnung in Vorbereitung (bisher nur Testdatei-Export)" },
  { topic: "Unterschrift je Behandlung, Leistungsnachweis, Zuzahlungsquittung", podo: true },
  { topic: "Telematikinfrastruktur (TI/KIM)", podo: "KIM vorbereitet, Echtbetrieb mit eigenen TI-Komponenten" },
  { topic: "Verordnung per Foto auslesen", podo: "eingebaut (Testmodus, Felder werden bestätigt)" },
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
      <JsonLd data={[softwareApplicationLd(), organizationLd(), faqLd(HOME_FAQ)]} />
      {/* Hero */}
      <section aria-labelledby="hero-title" className="relative overflow-hidden">
        <div className="mx-auto grid grid-cols-1 max-w-6xl items-center gap-10 px-4 pb-12 pt-12 sm:px-6 md:pt-16 lg:grid-cols-[1fr_1.05fr] lg:gap-8 lg:pb-16">
          <div>
            <Badge tone="primary">Gebaut nur für Podologie</Badge>
            <h1 id="hero-title" className="mt-5 font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.6rem]">
              <span className="block text-xl font-semibold tracking-normal text-muted sm:text-2xl">Praxissoftware für Podologie</span>
              <span className="mt-3 block">Ihre Praxis läuft.</span>{" "}<span className="block text-primary">Sie behandeln.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted">
              PodoHero dokumentiert am Behandlungsstuhl, füllt freie Termine über die Warteliste nach, erinnert Ihre Patient:innen und schließt abends
              die Kasse. Eine Software für die ganze Praxis – vom Termin bis zum Z-Bon.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <TrialButton variant="accent" className="h-12 px-6 text-base">
                {" "}<ArrowRight size={18} aria-hidden />
              </TrialButton>
              <LinkButton href="/funktionen" variant="secondary" className="h-12 px-6 text-base">Funktionen ansehen</LinkButton>
            </div>
            <p className="mt-4 text-sm text-muted"><TrialText open="30 Tage kostenlos · keine Zahlungsdaten nötig · endet automatisch" /></p>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium" aria-label="Datenschutz">
              <li className="inline-flex items-center gap-1.5"><ServerCog size={16} aria-hidden className="text-primary" /> Hosting in Deutschland</li>
              <li className="inline-flex items-center gap-1.5"><Lock size={16} aria-hidden className="text-primary" /> Fotos verschlüsselt</li>
              <li className="inline-flex items-center gap-1.5"><KeyRound size={16} aria-hidden className="text-primary" /> Zwei-Faktor-Anmeldung</li>
            </ul>
          </div>

          {/* Echte Screenshots mit erfundenen Demodaten */}
          <HeroShots />
        </div>
      </section>

      {/* Erklärvideo: Click-to-load vom eigenen Server (kein Laden vor dem Klick, siehe ExplainerVideoPlayer) */}
      <section aria-labelledby="erklaervideo" className="mx-auto max-w-4xl px-4 pb-14 sm:px-6">
        <JsonLd data={videoObjectLd()} />
        <h2 id="erklaervideo" className="text-center font-display text-2xl font-semibold tracking-tight sm:text-3xl">PodoHero in zweieinhalb Minuten</h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-muted">Vom Tagesüberblick bis zum Tagesabschluss – ein kurzer Rundgang durch die Software.</p>
        <div className="mt-6">
          <ExplainerVideoPlayer />
        </div>
        <p className="mx-auto mt-3 max-w-3xl text-center text-xs text-muted sm:text-sm" data-testid="erklaervideo-hinweis">{EXPLAINER_VIDEO_NOTE}</p>
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
          <div className="mt-10 grid grid-cols-1 gap-x-6 gap-y-10 md:grid-cols-2 xl:grid-cols-4">
            {CAPABILITIES.map(({ group, items }) => (
              <div key={group}>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">{group}</h3>
                <ul className="mt-3 flex flex-col gap-2">
                  {items.map(({ icon: Icon, title, text, href, test, pilot }) => (
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
                            {pilot ? (
                              <span className="rounded-full bg-surface-2 px-2 py-px text-[11px] font-semibold text-muted">Pilot in Vorbereitung</span>
                            ) : null}
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

      {/* GKV-Abrechnung */}
      <section aria-labelledby="gkv" className="mx-auto max-w-6xl px-4 pt-16 sm:px-6">
        <div className="grid grid-cols-1 gap-8 rounded-[24px] border border-border bg-surface p-6 sm:p-10 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <Badge tone="primary"><ClipboardList size={14} aria-hidden className="mr-1" /> Für Kassenpraxen</Badge>
            <h2 id="gkv" className="mt-4 font-display text-3xl font-semibold tracking-tight">Podologie-Software mit GKV-Abrechnung</h2>
            <p className="mt-3 text-muted">
              Von der Heilmittelverordnung bis zum Abrechnungslauf: PodoHero prüft jede Verordnung gegen die Vorgaben des Podologie-Vertrags und
              meldet, was vor der Abrechnung fehlt. Abgerechnet wird über Ihr Abrechnungszentrum: Abrechnungsreife Verordnungen stehen als
              Export im neutralen Format bereit – ob Ihr Zentrum das Format übernimmt, bitte vorab klären; eine feste Partneranbindung besteht noch
              nicht. Die Übermittlung nach § 302 SGB V übernimmt das Zentrum.
            </p>
            <p className="mt-3 rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
              <span className="font-semibold text-text">In Vorbereitung:</span> Direktabrechnung nach § 302 SGB V. Prüflauf und
              Testdatei-Export sind eingebaut; ein Versand an die Kassen ist noch nicht möglich.
            </p>
            <LinkButton href="/funktionen#verordnungen" variant="secondary" className="mt-6">GKV-Funktionen im Detail</LinkButton>
          </div>
          <ul className="grid content-start gap-3">
            {GKV_POINTS.map((t) => (
              <li key={t} className="flex gap-2.5 text-[15px]"><Check size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" /> {t}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* Live-Beispiele */}
      <section aria-labelledby="live" className="mx-auto max-w-6xl px-4 pt-16 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="live" className="font-display text-3xl font-semibold tracking-tight">Live-Beispiele aus PodoHero</h2>
            <p className="mt-2 max-w-2xl text-muted">Keine Illustrationen: So sieht die Software im Praxisalltag aus – aufgenommen mit erfundenen Demodaten.</p>
          </div>
          <Link href="/funktionen" className="inline-flex items-center gap-1 rounded-lg font-semibold text-primary hover:underline">
            Alle Screenshots <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
        <ul className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {LIVE.map(({ shot, title, text, href, tag }) => (
            <li key={title}>
              <Link
                href={href}
                className="group flex h-full flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-[0_18px_40px_-24px_rgb(15_42_46/0.5)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              >
                <div className="relative aspect-[16/10] overflow-hidden border-b border-border bg-surface-2">
                  <ShotImage shot={shot} decorative sizes="(min-width: 1024px) 360px, (min-width: 640px) 50vw, 100vw" className="transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none" />
                  <span className="absolute left-3 top-3 rounded-full bg-bg/90 px-2.5 py-0.5 text-xs font-semibold backdrop-blur">{tag}</span>
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <p className="font-semibold group-hover:text-primary">{title}</p>
                  <p className="mt-1 flex-1 text-sm text-muted">{text}</p>
                  <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                    Mehr dazu <ArrowRight size={14} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
        <DemoDataNote className="mt-4" />
      </section>

      {/* Gebaut nur für Podologie */}
      <section aria-labelledby="nur-podologie" className="mx-auto max-w-6xl px-4 pt-16 sm:px-6">
        <div className="grid grid-cols-1 items-center gap-10 rounded-[24px] border border-border bg-surface p-6 sm:p-10 lg:grid-cols-[1fr_1fr]">
          <div>
            <Badge tone="primary"><Footprints size={14} aria-hidden className="mr-1" /> Gebaut nur für Podologie</Badge>
            <h2 id="nur-podologie" className="mt-4 font-display text-3xl font-semibold tracking-tight">Von Grund auf für die Podologie entwickelt</h2>
            <p className="mt-3 text-muted">
              PodoHero kennt nur ein Fach: Ihres. Deshalb sind Fußschema, Nagelspange, Sterilgut-Charge und Pflegeheim-Besuchstag genau dort, wo
              Sie sie im Behandlungsalltag brauchen.
            </p>
            <ul className="mt-5 grid gap-2.5">
              {ONLY_PODO.map((t) => (
                <li key={t} className="flex gap-2.5 text-[15px]"><Check size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" /> {t}</li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <LinkButton href="/vergleich" variant="secondary">Mit anderer Software vergleichen</LinkButton>
              <LinkButton href="/wechseln" variant="ghost">Wechsel planen <ArrowRight size={16} aria-hidden /></LinkButton>
            </div>
          </div>
          <ScreenshotFrame shot={SHOTS.fuss3d} sizes="(min-width: 1024px) 520px, 100vw" />
        </div>
      </section>

      {/* Ein Tag mit PodoHero */}
      <section aria-labelledby="tag" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="tag" className="font-display text-3xl font-semibold tracking-tight">Ein Tag mit PodoHero</h2>
        <p className="mt-2 max-w-2xl text-muted">Vom Aufschließen bis zum Feierabend: So greifen die Bausteine im Praxisalltag ineinander.</p>
        <ol className="mt-10 grid grid-cols-1 gap-x-8 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
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
          <h2 id="vergleich" className="font-display text-3xl font-semibold tracking-tight">Wo PodoHero den Schwerpunkt setzt</h2>
          <p className="mt-2 max-w-3xl text-muted">
            PodoHero setzt den Schwerpunkt auf mobile Doku, Patientenbindung und Selbstzahler – und bereitet GKV-Verordnungen bis zur Abrechnung
            vor. Abgerechnet wird über ein Abrechnungszentrum (Export im neutralen Format, eine feste Partneranbindung besteht noch nicht); die Direktabrechnung nach § 302 SGB V ist in Vorbereitung, KIM vorbereitet. Konkrete Gegenüberstellungen mit Quellen finden
            Sie unter <Link href="/vergleich" className="font-semibold text-primary hover:underline">Podologie-Software im Vergleich</Link>.
          </p>
          <ScrollArea label="Schwerpunkte von PodoHero" className="mt-8 rounded-[var(--radius-card)] border border-border bg-surface">
            <table className="w-full border-collapse text-left text-[15px]">
              <caption className="sr-only">Schwerpunkte und Funktionsumfang von PodoHero</caption>
              <thead>
                <tr className="bg-surface-2 text-sm">
                  <th scope="col" className="px-4 py-3 font-semibold">Thema</th>
                  <th scope="col" className="px-4 py-3 font-semibold">PodoHero</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.topic} className="border-t border-border">
                    <th scope="row" className="px-4 py-3 font-medium">{row.topic}</th>
                    <td className="px-4 py-3"><CellView value={row.podo} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </div>
      </section>

      {/* Sicherheit */}
      <section aria-labelledby="sicherheit-kurz" className="bg-primary-soft text-primary-soft-text">
        <div className="mx-auto grid grid-cols-1 max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 id="sicherheit-kurz" className="font-display text-3xl font-semibold tracking-tight">Gesundheitsdaten verdienen mehr als ein Passwort</h2>
            <p className="mt-3">Wir beschreiben genau, was technisch umgesetzt ist – und was noch nicht.</p>
            <LinkButton href="/sicherheit" variant="primary" className="mt-6">Sicherheit im Detail</LinkButton>
          </div>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <p className="mt-2 text-muted">
              {PRICE_NOTE.replace(" (siehe unten).", ".")}{" "}
              <Link href="/preise#vorlaeufig" className="font-semibold text-primary underline-offset-2 hover:underline">Was „vorläufig“ bedeutet</Link>. Kostenpflichtige Tarife monatlich kündbar.
            </p>
          </div>
          <LinkButton href="/preise" variant="secondary">Alle Tarife</LinkButton>
        </div>
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {PUBLIC_PLANS.map((p) => (
            <div key={p.id} className={`rounded-[var(--radius-card)] border p-5 ${p.highlight ? "border-primary bg-surface" : "border-border bg-surface"}`}>
              <p className="font-semibold">{p.name}</p>
              <p className="mt-2 font-display text-3xl font-bold">{p.price}</p>
              <p className="text-sm text-muted">{p.gross ? `netto ${p.period}` : p.period}</p>
              {p.gross ? <p className="text-xs text-muted">{p.gross}</p> : null}
              <p className="mt-3 text-sm">{p.therapists}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <div className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <FaqList items={HOME_FAQ} title="Häufige Fragen zu GKV-Abrechnung, Kasse und Datenschutz" />
      </div>

      {/* Abschluss */}
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="flex flex-col items-start gap-6 rounded-[24px] bg-primary px-6 py-10 text-on-primary sm:px-10 md:flex-row md:items-center">
          <div className="flex-1">
            <h2 className="font-display text-3xl font-semibold tracking-tight"><TrialText open="In zwei Minuten startklar" closed="PodoHero kennenlernen" /></h2>
            <p className="mt-2">
              <TrialText
                open="Praxis anlegen, Leistungskatalog übernehmen, Excel-Liste importieren. Schnittstellen starten im Testmodus."
                closed="Testzugang auf Anfrage – wir schalten Praxen schrittweise frei. Danach: Leistungskatalog übernehmen, Daten importieren, Schnittstellen im Testmodus ausprobieren."
              />
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <TrialButton variant="accent" className="h-12 px-6 text-base" label="Kostenlos testen" />
            <LinkButton href="/login" variant="secondary" className="h-12 px-6 text-base">
              Anmelden
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}
