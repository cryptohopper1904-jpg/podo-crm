/**
 * Wissensbereich (/wissen): sachliche Praxis-Artikel für Podologie-Praxen.
 * Rechtliche/steuerliche Aussagen nur mit Quelle (Gesetzestext, G-BA, Behörden); keine Rechts- oder Steuerberatung.
 * Vor Änderungen Quellen erneut prüfen und `modified` anpassen.
 */
import type { Source } from "./competitors";

export type ArticleSection = { heading: string; paragraphs?: string[]; list?: string[]; ordered?: boolean };

export type Article = {
  slug: string;
  title: string;
  description: string;
  /** ISO-Datum */
  published: string;
  modified: string;
  minutes: number;
  topic: "Abrechnung" | "Steuern" | "Verordnungen" | "Hygiene" | "Organisation";
  intro: string;
  sections: ArticleSection[];
  sources: Source[];
  /** Weiterführend in PodoHero */
  feature?: { href: string; label: string };
  legal: boolean;
};

const G = (path: string) => `https://www.gesetze-im-internet.de/${path}`;

export const ARTICLES: Article[] = [
  {
    slug: "sammelrechnung-und-quittung-podologie",
    title: "Sammelrechnung und Quittung in der Podologie",
    description: "Wann reicht eine Quittung, wann braucht es eine Rechnung, und wie funktioniert eine Sammelrechnung für Pflegeheime oder Stammpatient:innen? Pflichtangaben, Kleinbetragsrechnung und Aufbewahrung im Überblick.",
    published: "2026-11-13",
    modified: "2026-11-13",
    minutes: 6,
    topic: "Abrechnung",
    intro:
      "Viele podologische Praxen kassieren Selbstzahler-Leistungen direkt nach der Behandlung – bar oder mit Karte. Andere rechnen monatlich ab, etwa mit Pflegeheimen oder Angehörigen. Beides ist möglich, wenn die Belege die gesetzlichen Angaben enthalten und lückenlos nummeriert sind.",
    sections: [
      {
        heading: "Quittung, Rechnung, Sammelrechnung – die Begriffe",
        list: [
          "Quittung: Beleg über eine sofort bezahlte Leistung. Steuerlich ist auch eine Quittung eine Rechnung, wenn sie die Pflichtangaben enthält.",
          "Rechnung: Beleg über eine Leistung, die später bezahlt wird (z. B. per Überweisung mit Zahlungsziel).",
          "Sammelrechnung: eine Rechnung über mehrere Leistungen – etwa alle Behandlungen eines Monats für eine Person oder für mehrere Bewohner:innen eines Pflegeheims.",
        ],
      },
      {
        heading: "Pflichtangaben einer Rechnung",
        paragraphs: [
          "§ 14 Abs. 4 UStG nennt die Pflichtangaben: vollständiger Name und Anschrift von Praxis und Empfänger:in, Steuernummer oder USt-IdNr., Ausstellungsdatum, eine fortlaufende, einmalig vergebene Rechnungsnummer, Menge und Art der Leistung, Zeitpunkt bzw. Zeitraum der Leistung, Entgelt sowie Steuersatz und Steuerbetrag – oder ein Hinweis auf die Steuerbefreiung.",
          "Für steuerfreie Heilbehandlungen gehört deshalb ein Hinweis wie „umsatzsteuerfrei nach § 4 Nr. 14 Buchst. a UStG“ auf den Beleg. Bei kosmetischen Leistungen wird Umsatzsteuer ausgewiesen.",
        ],
      },
      {
        heading: "Kleinbetragsrechnung bis 250 Euro",
        paragraphs: [
          "Für Rechnungen bis 250 Euro brutto erlaubt § 33 UStDV vereinfachte Angaben: Name und Anschrift der Praxis, Ausstellungsdatum, Menge und Art der Leistung, Bruttobetrag sowie Steuersatz – oder der Hinweis auf die Steuerbefreiung. Name und Anschrift der Patientin bzw. des Patienten sind dann nicht zwingend, in der Praxis aber oft sinnvoll (Zuordnung, Erstattung durch Versicherungen).",
        ],
      },
      {
        heading: "Sammelrechnung: worauf es ankommt",
        list: [
          "Leistungszeitraum angeben: Bei mehreren Leistungen genügt der Kalendermonat als Leistungszeitraum (§ 31 Abs. 4 UStDV).",
          "Jede Behandlung nur einmal abrechnen: Leistungen, die schon per Quittung bezahlt wurden, nicht nochmals aufnehmen – oder als Anzahlung anrechnen.",
          "Rechnungsempfänger klären: Pflegeheim, Angehörige oder Betreuer:in – mit vollständiger Anschrift.",
          "Positionen nachvollziehbar beschreiben: Datum, Leistung, ggf. Person – aber keine Diagnosen auf die Rechnung schreiben, die nicht nötig sind.",
        ],
      },
      {
        heading: "E-Rechnung und Schweigepflicht",
        paragraphs: [
          "Seit 2025 gilt für Rechnungen an andere Unternehmen – etwa an ein Pflegeheim als Rechnungsempfänger – schrittweise die Pflicht zur elektronischen Rechnung (E-Rechnung). Ausgenommen sind unter anderem Rechnungen über steuerfreie Leistungen nach § 4 Nr. 8 bis 29 UStG und Kleinbetragsrechnungen. Ob und ab wann das für Ihre Praxis gilt, lassen Sie bitte steuerlich prüfen.",
          "Rechnungen enthalten Gesundheitsdaten (welche Behandlung, wann, bei wem). Sie unterliegen der Schweigepflicht (§ 203 StGB) und dem Datenschutz (DSGVO). Rechnungen an Dritte – Angehörige, Betreuer:innen oder ein Pflegeheim – nur mit Einwilligung der Patientin bzw. des Patienten oder mit nachgewiesener Vertretungsbefugnis (z. B. Betreuung mit passendem Aufgabenkreis).",
        ],
      },
      {
        heading: "Nummernkreise, Storno und Aufbewahrung",
        paragraphs: [
          "Rechnungsnummern müssen einmalig sein; getrennte Nummernkreise (z. B. für Quittungen und Sammelrechnungen) sind zulässig. Ausgestellte Rechnungen werden nicht geändert, sondern mit einer Stornorechnung korrigiert.",
          "Rechnungen sind Buchungsbelege. Für sie gilt nach § 147 Abs. 3 AO eine Aufbewahrungsfrist von acht Jahren (seit 2025; vorher zehn Jahre), umsatzsteuerlich ergänzt durch § 14b UStG. Die Frist beginnt mit dem Schluss des Kalenderjahres, in dem die Rechnung ausgestellt wurde (§ 147 Abs. 4 AO). Die Behandlungsdokumentation ist davon unabhängig nach § 630f Abs. 3 BGB zehn Jahre nach Abschluss der Behandlung aufzubewahren.",
        ],
      },
      {
        heading: "So unterstützt PodoHero",
        paragraphs: [
          "PodoHero vergibt lückenlose Nummernkreise je Belegart, sperrt ausgestellte Belege gegen Änderungen und erstellt Sammelrechnungen für Pflegeheime aus den Behandlungen des Besuchstags. Bereits per Quittung bezahlte Anzahlungen werden angerechnet.",
        ],
      },
    ],
    sources: [
      { label: "§ 14 UStG – Ausstellung von Rechnungen", url: G("ustg_1980/__14.html") },
      { label: "§ 31 UStDV – Angaben in der Rechnung", url: G("ustdv_1980/__31.html") },
      { label: "§ 33 UStDV – Rechnungen über Kleinbeträge", url: G("ustdv_1980/__33.html") },
      { label: "§ 147 AO – Ordnungsvorschriften für die Aufbewahrung von Unterlagen", url: G("ao_1977/__147.html") },
      { label: "§ 14b UStG – Aufbewahrung von Rechnungen", url: G("ustg_1980/__14b.html") },
      { label: "§ 630f BGB – Dokumentation der Behandlung", url: G("bgb/__630f.html") },
      { label: "§ 203 StGB – Verletzung von Privatgeheimnissen", url: G("stgb/__203.html") },
    ],
    feature: { href: "/funktionen#rechnungen", label: "Rechnungen, Kasse & Gutscheine in PodoHero" },
    legal: true,
  },
  {
    slug: "umsatzsteuer-podologie-paragraf-4-nr-14-ustg",
    title: "Umsatzsteuer bei podologischen Leistungen (§ 4 Nr. 14 UStG) – Überblick",
    description: "Wann sind podologische Leistungen umsatzsteuerfrei, wann fallen 19 % an? Heilbehandlung vs. kosmetische Fußpflege, Produktverkauf, Gutscheine und Kleinunternehmerregelung im Überblick.",
    published: "2026-11-13",
    modified: "2026-11-13",
    minutes: 6,
    topic: "Steuern",
    intro:
      "Podologische Behandlungen sind häufig umsatzsteuerfrei – aber nicht automatisch alles, was in einer Podologie-Praxis passiert. Entscheidend ist das therapeutische Ziel der jeweiligen Leistung.",
    sections: [
      {
        heading: "Die Grundregel",
        paragraphs: [
          "Nach § 4 Nr. 14 Buchst. a UStG sind Heilbehandlungen im Bereich der Humanmedizin steuerfrei, die im Rahmen der Ausübung eines Heilberufs oder einer ähnlichen heilberuflichen Tätigkeit durchgeführt werden. Podologinnen und Podologen mit Erlaubnis nach dem Podologengesetz üben eine solche Tätigkeit aus (Abschnitt 4.14.4 des Umsatzsteuer-Anwendungserlasses). Fußpflege ohne diese Erlaubnis – etwa kosmetische oder medizinische Fußpflege ohne Podologen-Erlaubnis – ist danach nicht befreit.",
          "Steuerfrei ist dabei nur die Heilbehandlung: Sie muss der Diagnose, Behandlung oder Vorbeugung von Krankheiten dienen. Ein Indiz ist eine ärztliche Verordnung; auch Selbstzahler-Leistungen können steuerfrei sein, wenn ein therapeutisches Ziel besteht und dokumentiert ist.",
        ],
      },
      {
        heading: "Typische Fälle in der Praxis",
        list: [
          "Podologische Komplexbehandlung bei diabetischem Fußsyndrom (Verordnung): in der Regel steuerfrei.",
          "Nagelkorrekturspange bei eingewachsenem Nagel mit Befund: in der Regel steuerfrei, wenn therapeutisch begründet.",
          "Kosmetische Fußpflege, Nagellack, Wellness-Anwendungen: steuerpflichtig (Regelsteuersatz).",
          "Verkauf von Cremes, Einlagen oder Pflegeprodukten: eigener Umsatz, in der Regel steuerpflichtig.",
          "Gutscheine: Einzweck- und Mehrzweckgutscheine werden unterschiedlich behandelt (§ 3 Abs. 13–15 UStG) – maßgeblich ist, ob die geschuldete Steuer beim Verkauf schon feststeht.",
        ],
      },
      {
        heading: "Dokumentation als Nachweis",
        paragraphs: [
          "Weil es auf das therapeutische Ziel ankommt, sollte die Behandlungsdokumentation den Befund und das Behandlungsziel festhalten. Gemischte Rechnungen (Heilbehandlung und kosmetische Leistung) werden nach Positionen getrennt mit dem jeweils richtigen Steuersatz ausgewiesen.",
        ],
      },
      {
        heading: "Kleinunternehmerregelung",
        paragraphs: [
          "Wer nur geringe steuerpflichtige Umsätze hat, kann die Kleinunternehmerregelung nach § 19 UStG nutzen. Seit 2025 gelten als Grenzen 25.000 Euro Gesamtumsatz im Vorjahr und 100.000 Euro im laufenden Jahr. Bei der Berechnung des Gesamtumsatzes bleiben bestimmte steuerfreie Umsätze – darunter Heilbehandlungen nach § 4 Nr. 14 UStG – außer Betracht (§ 19 Abs. 2 UStG). Wird die 100.000-Euro-Grenze im laufenden Jahr überschritten, entfällt die Regelung ab diesem Umsatz. Ob sich die Regelung lohnt, sollte die Steuerberatung beurteilen.",
        ],
      },
      {
        heading: "So unterstützt PodoHero",
        paragraphs: [
          "Leistungen tragen in PodoHero einen Steuersatz. Bei 0 % fragt der „USt-Wächter“ vor dem Ausstellen nach dem therapeutischen Ziel und schreibt den Hinweis auf die Steuerbefreiung auf den Beleg. Die Kleinunternehmerregelung lässt sich in den Praxisdaten einstellen.",
        ],
      },
    ],
    sources: [
      { label: "§ 4 UStG – Steuerbefreiungen (Nr. 14)", url: G("ustg_1980/__4.html") },
      { label: "§ 19 UStG – Besteuerung der Kleinunternehmer", url: G("ustg_1980/__19.html") },
      { label: "§ 3 UStG – Lieferung, sonstige Leistung (Gutscheine, Abs. 13–15)", url: G("ustg_1980/__3.html") },
      { label: "Podologengesetz (PodG)", url: G("podg/") },
      { label: "Umsatzsteuer-Anwendungserlass (Abschnitt 4.14.4) – Bundesfinanzministerium", url: "https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/Umsatzsteuer-Anwendungserlass.html" },
    ],
    feature: { href: "/funktionen#rechnungen", label: "USt-Logik und Belege in PodoHero" },
    legal: true,
  },
  {
    slug: "verordnung-df-nf-qf-praxissoftware",
    title: "Verordnung DF, NF, QF – was die Praxissoftware prüfen sollte",
    description: "Diagnosegruppen der podologischen Therapie, Fristen für den Behandlungsbeginn, Einheiten und Unterbrechungen: eine Checkliste, was Ihre Software bei GKV-Verordnungen im Blick behalten sollte.",
    published: "2026-11-13",
    modified: "2026-11-13",
    minutes: 5,
    topic: "Verordnungen",
    intro:
      "Formfehler auf Verordnungen kosten Geld: Abrechnungszentren und Krankenkassen setzen ab, wenn Fristen oder Pflichtangaben nicht stimmen. Eine Praxissoftware kann viele Prüfungen übernehmen – die fachliche Verantwortung bleibt in der Praxis.",
    sections: [
      {
        heading: "Die Diagnosegruppen der podologischen Therapie",
        list: [
          "DF – diabetisches Fußsyndrom.",
          "NF – Schädigungen am Fuß infolge einer sensiblen oder sensomotorischen Neuropathie (seit 1. Juli 2020 verordnungsfähig).",
          "QF – Schädigungen am Fuß infolge eines Querschnittsyndroms (seit 1. Juli 2020 verordnungsfähig).",
          "UI1 / UI2 – eingewachsener Zehennagel (Unguis incarnatus) zur Behandlung mit Nagelkorrekturspange.",
        ],
        paragraphs: ["Welche Diagnosegruppe zu welcher Indikation gehört und welche Heilmittel verordnet werden können, regelt die Heilmittel-Richtlinie des G-BA mit dem Heilmittelkatalog."],
      },
      {
        heading: "Fristen im Blick behalten",
        list: [
          "Behandlungsbeginn: grundsätzlich innerhalb von 28 Kalendertagen nach Ausstellung, bei dringlichem Behandlungsbedarf innerhalb von 14 Kalendertagen.",
          "Unterbrechungen: Grundsätzlich verliert eine Verordnung ihre Gültigkeit, wenn die Behandlung länger als 14 Kalendertage ohne angemessene Begründung unterbrochen wird (§ 16 Abs. 4 HeilM-RL). Für Maßnahmen der podologischen Therapie gilt das ausdrücklich nicht – Unterbrechungen machen die Verordnung hier nicht ungültig. Ergänzende Regeln können sich aus Ihrem Vertrag nach § 125 SGB V ergeben.",
          "Frequenz und Einheiten: verbrauchte und offene Einheiten je Position mitzählen; Hinweis rechtzeitig vor der letzten Einheit (Folgeverordnung).",
        ],
      },
      {
        heading: "Was eine Software prüfen sollte",
        ordered: true,
        list: [
          "Pflichtfelder erfasst: Diagnosegruppe, ICD-10, Heilmittel und Einheiten, Arzt-Angaben, Ausstellungsdatum.",
          "Ampel für den Behandlungsbeginn und kritische Fristen.",
          "Einheiten je Position mit Restzählung – jede dokumentierte Behandlung bucht eine Einheit.",
          "Zuzahlung und Befreiung vermerken.",
          "Abrechnungsreife markieren und gesammelt an das Abrechnungszentrum übergeben.",
          "Regelwerk versioniert: Welche Regeln galten zum Zeitpunkt der Prüfung?",
        ],
      },
      {
        heading: "So unterstützt PodoHero",
        paragraphs: [
          "PodoHero erfasst Verordnungen mit Positionen und Foto, zeigt eine Fristen-Ampel und zählt Einheiten bei jeder Behandlung. Abrechnungsreife Verordnungen gehen per Export an ein Abrechnungszentrum, das die Übermittlung nach § 302 SGB V übernimmt. Die Prüfregeln sind versioniert und vor dem Echtbetrieb gegen die aktuelle Richtlinie zu prüfen.",
        ],
      },
    ],
    sources: [
      { label: "G-BA – Heilmittel-Richtlinie (aktuelle, konsolidierte Fassung)", url: "https://www.g-ba.de/richtlinien/12/" },
      { label: "G-BA – Verordnung von Heilmitteln", url: "https://www.g-ba.de/themen/veranlasste-leistungen/heilmittel/verordnung-heilmittel-vertragsaerzte/" },
      { label: "G-BA – Beschluss Podologische Therapie (NF/QF), 2020", url: "https://www.g-ba.de/downloads/39-261-4179/2020-02-20_HeilM-RL_Podologische-Therapie.pdf" },
      { label: "KVBW – FAQ Heilmittel", url: "https://www.kvbawue.de/praxis/verordnungen/heilmittel/faq" },
      { label: "§ 125 SGB V – Verträge mit Leistungserbringern von Heilmitteln", url: G("sgb_5/__125.html") },
      { label: "§ 302 SGB V – Abrechnung der sonstigen Leistungserbringer", url: G("sgb_5/__302.html") },
    ],
    feature: { href: "/funktionen#verordnungen", label: "Verordnungen in PodoHero" },
    legal: true,
  },
  {
    slug: "hygieneplan-podologie-checkliste",
    title: "Hygieneplan Podologie: Checkliste für den Praxisalltag",
    description: "Was in einen Hygieneplan für die podologische Praxis gehört: Flächen, Hände, Instrumentenaufbereitung, Sterilgut-Freigabe, Geräte-Fristen und Dokumentation – als praktische Checkliste.",
    published: "2026-11-13",
    modified: "2026-11-13",
    minutes: 6,
    topic: "Hygiene",
    intro:
      "In der Podologie wird mit Instrumenten gearbeitet, die Haut und Nägel durchdringen oder verletzen können. Die Aufbereitung dieser Medizinprodukte und ein gelebter Hygieneplan gehören deshalb zu den wichtigsten Pflichten der Praxis.",
    sections: [
      {
        heading: "Rechtlicher Rahmen (Überblick)",
        paragraphs: [
          "Die Aufbereitung von Medizinprodukten regelt § 8 der Medizinprodukte-Betreiberverordnung (MPBetreibV): Sie ist mit geeigneten validierten Verfahren durchzuführen; wer aufbereitet, braucht die dafür nötige Sachkenntnis (§ 5 MPBetreibV). Eine ordnungsgemäße Aufbereitung wird vermutet, wenn die gemeinsame Empfehlung der Kommission für Krankenhaushygiene und Infektionsprävention (KRINKO) beim RKI und des BfArM „Anforderungen an die Hygiene bei der Aufbereitung von Medizinprodukten“ (2012) beachtet wird. Für den Arbeitsschutz gilt die TRBA 250. Viele Bundesländer haben zusätzlich eigene Hygieneverordnungen; die Überwachung liegt beim Gesundheitsamt.",
        ],
      },
      {
        heading: "Checkliste: täglich",
        list: [
          "Flächendesinfektion des Behandlungsplatzes nach jeder Patientin bzw. jedem Patienten.",
          "Händehygiene: Desinfektionsmittel und Handschuhe aufgefüllt.",
          "Instrumente aufbereitet: Reinigung, Desinfektion, Verpackung, Sterilisation.",
          "Sterilisator: Tagesprüfung dokumentiert – Vakuum-, Helix- bzw. Bowie-Dick-Test je nach Gerät und Herstellerangaben.",
          "Absaugung und Fräse gereinigt, Filter geprüft.",
          "Sterilgut-Charge erst nach Freigabe verwenden; Chargennummer in der Behandlungsdoku vermerken.",
        ],
      },
      {
        heading: "Checkliste: wöchentlich und monatlich",
        list: [
          "Ultraschallbad: Lösung wechseln, Becken reinigen.",
          "Wasserführende Systeme spülen.",
          "Lagerung von Sterilgut prüfen (Verfallsdaten, Verpackung unbeschädigt).",
          "Materialbestand prüfen und nachbestellen.",
        ],
      },
      {
        heading: "Fristen für Geräte",
        list: [
          "Validierung der Aufbereitungsverfahren (Sterilisator, Siegelgerät, ggf. Thermodesinfektor) in den festgelegten Abständen.",
          "Wartung nach Herstellerangaben.",
          "Elektrische Prüfung ortsveränderlicher Geräte (z. B. nach DGUV Vorschrift 3).",
          "Einweisungen des Teams in Geräte dokumentieren.",
        ],
      },
      {
        heading: "Dokumentation, die sich bewährt",
        paragraphs: [
          "Jede Charge mit Datum, Gerät, Zyklusnummer, Ergebnis der Indikatoren und Freigabe durch eine berechtigte Person. So lässt sich bei einem Problem nachvollziehen, bei welchen Behandlungen welche Instrumente verwendet wurden (Rückverfolgung).",
        ],
      },
      {
        heading: "So unterstützt PodoHero",
        paragraphs: [
          "PodoHero führt Sterilgut-Chargen mit Freigabe, QR-Etiketten und Rückverfolgung bis zur Behandlung, ein Gerätebuch mit Wartungs-, Validierungs- und Prüffristen, eine Tages-Checkliste und eine Materialliste mit Mindestbestand. Fristen in den nächsten 30 Tagen erscheinen als Aufgabe.",
        ],
      },
    ],
    sources: [
      { label: "§ 8 MPBetreibV – Aufbereitung von Medizinprodukten", url: G("mpbetreibv_2025/__8.html") },
      { label: "§ 5 MPBetreibV – Besondere Anforderungen (Sachkenntnis)", url: G("mpbetreibv_2025/__5.html") },
      { label: "RKI (edoc) – KRINKO/BfArM: Anforderungen an die Hygiene bei der Aufbereitung von Medizinprodukten (2012)", url: "https://edoc.rki.de/handle/176904/12400" },
      { label: "BAuA – TRBA 250", url: "https://www.baua.de/DE/Angebote/Regelwerk/TRBA/TRBA-250" },
    ],
    feature: { href: "/funktionen#praxis", label: "Hygiene & Gerätebuch in PodoHero" },
    legal: true,
  },
  {
    slug: "hausbesuche-und-pflegeheime-organisieren",
    title: "Hausbesuche und Pflegeheime organisieren",
    description: "Besuchstage planen, Touren fahren, schnell dokumentieren und sauber abrechnen: praktische Tipps für podologische Hausbesuche und die Versorgung in Pflegeeinrichtungen.",
    published: "2026-11-13",
    modified: "2026-11-13",
    minutes: 5,
    topic: "Organisation",
    intro:
      "Hausbesuche und Pflegeheime sind für viele Podologie-Praxen ein fester Bestandteil – und ein organisatorischer Kraftakt: Fahrzeiten, viele Bewohner:innen an einem Tag, Einwilligungen, Verordnungen und Rechnungen an unterschiedliche Empfänger.",
    sections: [
      {
        heading: "Vor dem Besuchstag",
        list: [
          "Bewohnerliste je Einrichtung pflegen: Risiken (z. B. Diabetes, Blutverdünner), Rechnungsempfänger, Ansprechpartner:in auf Station.",
          "Verordnungen prüfen: Hausbesuch verordnet? Fristen und Einheiten ausreichend?",
          "Einwilligungen und Datenschutzhinweise vorliegen haben – bei Betreuung mit der berechtigten Person klären.",
          "Termin mit der Einrichtung abstimmen und Liste vorab schicken.",
        ],
      },
      {
        heading: "Tour planen",
        list: [
          "Hausbesuche eines Tages in eine sinnvolle Reihenfolge bringen – Fahrzeit und Behandlungszeit getrennt betrachten.",
          "Startort festlegen (Praxis oder Zuhause) und Fahrten für das Fahrtenbuch festhalten – ohne Patientennamen im Ziel. Welche Angaben Ihr Fahrtenbuch enthalten muss und wie sich das mit der Schweigepflicht verträgt, klären Sie bitte mit Ihrer Steuerberatung.",
          "Material und Sterilgut für alle Besuche einpacken; Chargen notieren.",
        ],
      },
      {
        heading: "Vor Ort dokumentieren",
        paragraphs: [
          "Im Pflegeheim hilft eine Listen-Dokumentation: je Bewohner:in Leistungen antippen, Kurzbefund eintragen, speichern. Auffälligkeiten (z. B. Druckstellen, Wunden) gehören zusätzlich an die Pflege der Station – ohne mehr Gesundheitsdaten als nötig weiterzugeben.",
        ],
      },
      {
        heading: "Abrechnen",
        list: [
          "GKV-Leistungen mit Hausbesuch nach Verordnung über das Abrechnungszentrum.",
          "Selbstzahler-Leistungen: Sammelrechnung je Monat an Pflegeheim, Angehörige oder Betreuer:in – Leistungszeitraum und Positionen je Person angeben.",
          "Hausbesuchspauschalen und Wegegeld so abrechnen, wie es Ihre Preisliste bzw. Ihr Vertrag nach § 125 SGB V vorsieht.",
        ],
      },
      {
        heading: "So unterstützt PodoHero",
        paragraphs: [
          "PodoHero hat einen Pflegeheim-Modus mit Bewohnerlisten, Besuchstag und Schnell-Doku, erstellt Sammelrechnungen je Monat und plant Touren mit Strecke und Fahrzeit. An den Routing-Dienst gehen nur Koordinaten, keine Namen.",
        ],
      },
    ],
    sources: [
      { label: "§ 125 SGB V – Verträge mit Leistungserbringern von Heilmitteln", url: G("sgb_5/__125.html") },
      { label: "§ 31 UStDV – Angaben in der Rechnung (Leistungszeitraum)", url: G("ustdv_1980/__31.html") },
    ],
    feature: { href: "/funktionen#praxis", label: "Pflegeheime & Touren in PodoHero" },
    legal: true,
  },
];

export const articleBySlug = (slug: string) => ARTICLES.find((a) => a.slug === slug);
