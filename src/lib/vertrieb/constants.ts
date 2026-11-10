/**
 * Vertrieb (Plattform-Betreiber): Konstanten, Status, Standardvorlagen.
 * Bewusst klein gehalten: manueller Versand in kleinen Mengen, keine Automatik.
 */

export const LEAD_STATUSES = ["neu", "in_sequenz", "geantwortet", "interessiert", "kein_interesse", "abgemeldet", "kunde"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const isLeadStatus = (v: unknown): v is LeadStatus => typeof v === "string" && (LEAD_STATUSES as readonly string[]).includes(v);

export const STATUS_LABEL: Record<LeadStatus, string> = {
  neu: "Neu",
  in_sequenz: "In Sequenz",
  geantwortet: "Geantwortet",
  interessiert: "Interessiert",
  kein_interesse: "Kein Interesse",
  abgemeldet: "Abgemeldet",
  kunde: "Kunde",
};

/**
 * Status, bei denen die Sequenz endet. „interessiert“ gehört dazu: wer Interesse gezeigt hat, hat geantwortet –
 * danach schreibt der Betreiber persönlich, nicht mehr die Vorlage.
 */
export const STOP_STATUSES: readonly LeadStatus[] = ["geantwortet", "interessiert", "kein_interesse", "abgemeldet", "kunde"];

/** Anzahl Mails der Sequenz */
export const SEQUENCE_STEPS = 3;
/** Höchstens so viele Mails je Klick („Nächste Mail senden“) */
export const MAX_PER_CLICK = 20;
/** Höchstens so viele Mails in 24 Stunden (gleitend, nur erfolgreich versendete) */
export const MAX_PER_DAY = 50;

export const DEFAULT_DELAYS = { delay2Days: 5, delay3Days: 10 } as const;

export const PLACEHOLDERS = ["praxis", "ansprechpartner", "anrede", "ort", "absender"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export const PLACEHOLDER_HELP: Record<Placeholder, string> = {
  praxis: "Name der Praxis",
  ansprechpartner: "Ansprechpartner:in (kann leer sein)",
  anrede: "„Guten Tag Frau Muster“ bzw. „Guten Tag“ ohne Ansprechpartner:in",
  ort: "Ort der Praxis",
  absender: "Absendername aus den Einstellungen",
};

export const PRODUCT_URL = "https://podo.algoverdict.com";

export type Template = { subject: string; body: string };

export const DEFAULT_TEMPLATES: readonly Template[] = [
  {
    subject: "PodoHero – Praxissoftware für die Podologie in {{ort}}",
    body: [
      "{{anrede}},",
      "",
      "mein Name ist {{absender}}. Ich habe PodoHero entwickelt, eine Praxissoftware speziell für podologische Praxen – entstanden gemeinsam mit einer Podologie-Praxis aus Ihrer Region.",
      "",
      "PodoHero bündelt Terminkalender, Behandlungsdokumentation, Verordnungen, Rechnungen und Hausbesuchs-Touren an einem Ort und läuft im Browser sowie auf dem Tablet.",
      "",
      "Einen Überblick finden Sie unter " + PRODUCT_URL + ".",
      "",
      "Wenn es für {{praxis}} interessant klingt, zeige ich Ihnen PodoHero gern in einer kostenlosen Demo von 30 Minuten – telefonisch oder per Video, ganz unverbindlich. Antworten Sie einfach auf diese E-Mail mit einem passenden Termin.",
      "",
      "Mit freundlichen Grüßen",
      "{{absender}}",
    ].join("\n"),
  },
  {
    subject: "Kurze Nachfrage: PodoHero für {{praxis}}",
    body: [
      "{{anrede}},",
      "",
      "ich wollte kurz an meine letzte Nachricht erinnern. Ein Punkt, den Praxen an PodoHero besonders schätzen: Termine aus Doctolib werden automatisch übernommen, und aus einem Termin wird mit einem Klick die Rechnung – auf Wunsch gesammelt als Sammelrechnung zum Monats- oder Jahresende.",
      "",
      "Wenn Sie mögen, zeige ich Ihnen das in 30 Minuten kostenlos. Eine kurze Antwort mit einem Terminvorschlag genügt.",
      "",
      "Mit freundlichen Grüßen",
      "{{absender}}",
    ].join("\n"),
  },
  {
    subject: "Letzte Nachricht von mir zu PodoHero",
    body: [
      "{{anrede}},",
      "",
      "ich möchte Sie nicht weiter mit E-Mails belästigen – dies ist meine letzte Nachricht zu PodoHero.",
      "",
      "Falls Praxissoftware, Hausbesuchs-Touren mit Fahrtenbuch oder die Abrechnung später einmal ein Thema für {{praxis}} wird, melden Sie sich gern jederzeit. Alle Informationen finden Sie unter " + PRODUCT_URL + ".",
      "",
      "Vielen Dank für Ihre Zeit und weiterhin alles Gute für Ihre Praxis.",
      "",
      "Mit freundlichen Grüßen",
      "{{absender}}",
    ].join("\n"),
  },
];

export const UWG_NOTE =
  "Werbe-E-Mails ohne Einwilligung können nach § 7 UWG abgemahnt werden. Nur kleine, gezielte Mengen senden; Abmeldungen werden automatisch beachtet.";
