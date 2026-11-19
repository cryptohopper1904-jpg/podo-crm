/**
 * Vertrieb: Vorgaben der Rechtsprüfung (DSGVO/UWG) – rein und testbar.
 * - Herkunft je Lead: Quelle + Abrufdatum (Pflicht beim Import und beim manuellen Anlegen)
 * - Löschfrist: Erhebung + 6–12 Monate (Standard 12), gelöscht AM Löschdatum (deutscher Kalendertag); Schreiben und
 *   Antworten verlängern sie nicht. Mit Einwilligung: 24 Monate nach der letzten Antwort bzw. Einwilligung
 * - Einwilligung je Kanal (E-Mail, Telefon) mit Datum, Erteilungsweg, Wortlaut/Nachweis und Widerruf; ohne E-Mail-Einwilligung
 *   keine Werbe-E-Mails (serverseitig in eligibility()), ohne Telefon-Einwilligung keine Anzeige der Telefonnummer
 *   (außer Bestandskunde) und ein deutlicher Hinweis
 * - Datenschutzhinweis nach Art. 14 DSGVO als Vorlage für den ersten Kontakt per Brief (Entwurf), Frist: Abruf + 1 Monat
 */
import { berlinDateIso, dateDe } from "@/lib/format";

// ───────────── Löschfrist ─────────────

/** Löschfrist in Monaten ab Erhebung (Anlage) */
export const DELETE_MONTHS = { default: 12, min: 6, max: 12 } as const;
/** Spätestens so viele Monate nach der letzten Antwort/Reaktion der Praxis (nicht nach unserem eigenen Schreiben) */
export const REACTION_RETENTION_MONTHS = 12;
/** Mit gültiger Einwilligung: so viele Monate nach der letzten Reaktion der Praxis (Datenschutzerklärung § 6a) */
export const CONSENT_RETENTION_MONTHS = 24;

export const isDeleteMonths = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= DELETE_MONTHS.min && n <= DELETE_MONTHS.max;

/** n Monate addieren (UTC, unabhängig von der Zeitzone des Servers); Monatsende wird gekappt wie in Postgres. */
export function addMonthsUtc(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/** Löschdatum = Erhebung + n Monate (31.08. + 6 Monate = 28./29.02.). */
export function deleteAfterFor(createdAt: Date, months: number): Date {
  if (!isDeleteMonths(months)) throw new Error(`Löschfrist: ${DELETE_MONTHS.min} bis ${DELETE_MONTHS.max} Monate.`);
  return addMonthsUtc(createdAt, months);
}

/** Mindestabstand einer beim Bearbeiten neu gewählten Löschfrist zu heute – wer schneller löschen will, nutzt „Löschen“ */
export const DELETE_MIN_LEAD_DAYS = 7;

/** Kleinste beim Bearbeiten wählbare Frist (Löschung mindestens heute + 7 Tage); null = keine Frist mehr wählbar */
export function minDeleteMonths(createdAt: Date, now = new Date()): number | null {
  const min = now.getTime() + DELETE_MIN_LEAD_DAYS * 86_400_000;
  for (let n = DELETE_MONTHS.min; n <= DELETE_MONTHS.max; n++) if (addMonthsUtc(createdAt, n).getTime() >= min) return n;
  return null;
}

/** Welche Frist (Monate ab Anlage) ergibt dieses Löschdatum? null, wenn keine ganze Monatszahl im erlaubten Bereich passt (z. B. Altbestand). */
export function deleteMonthsOf(createdAt: Date, deleteAfter: Date): number | null {
  for (let n = DELETE_MONTHS.min; n <= DELETE_MONTHS.max; n++) {
    if (Math.abs(addMonthsUtc(createdAt, n).getTime() - deleteAfter.getTime()) < 2 * 86_400_000) return n;
  }
  return null;
}

// ───────────── Herkunft ─────────────

/** Abrufdatum „YYYY-MM-DD“: gültig, nicht vor 2000, nicht in der Zukunft (deutsche Zeit). Sonst Fehlertext. */
export function checkRetrievedDate(v: string, now = new Date()): { ok: true; date: string } | { ok: false; error: string } {
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { ok: false, error: "Bitte das Abrufdatum der Quelle angeben." };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== s) return { ok: false, error: "Abrufdatum ist ungültig." };
  if (s < "2000-01-01") return { ok: false, error: "Abrufdatum ist zu alt." };
  if (s > berlinDateIso(now)) return { ok: false, error: "Abrufdatum liegt in der Zukunft." };
  return { ok: true, date: s };
}

/** Kürzel der Praxissuche → lesbare Quelle */
const SOURCE_LABEL: Record<string, string> = {
  osm: "OpenStreetMap",
  "osm+impressum": "OpenStreetMap und Impressum der Praxis-Website",
};

export const sourceLabel = (source: string | null) => (source ? (SOURCE_LABEL[source] ?? source) : null);

/** Herkunft für Liste und Detail, z. B. „OpenStreetMap · abgerufen 12.11.2026“ */
export function originLabel(source: string | null, retrievedAt: string | null): string {
  const src = sourceLabel(source?.trim() || null) ?? "Quelle fehlt";
  return `${src} · ${retrievedAt ? `abgerufen ${dateDe(`${retrievedAt}T12:00:00Z`)}` : "Abrufdatum fehlt"}`;
}

// ───────────── Erstbrief (Art. 14 Abs. 3 DSGVO: spätestens einen Monat nach Erlangung) ─────────────

/** Frist für den Erstbrief mit Datenschutzhinweis: Abrufdatum + 1 Monat (YYYY-MM-DD); null ohne Abrufdatum */
export function art14Deadline(retrievedAt: string | null): string | null {
  if (!retrievedAt || !/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt)) return null;
  return addMonthsUtc(new Date(`${retrievedAt}T00:00:00Z`), 1).toISOString().slice(0, 10);
}

/** Erstbrief überfällig: Frist abgelaufen und kein Versand vermerkt. Keine automatische Löschung – das entscheidet der Mensch. */
export function art14Overdue(l: { sourceRetrievedAt: string | null; art14NoticeAt: string | null }, today = berlinDateIso()): boolean {
  const d = art14Deadline(l.sourceRetrievedAt);
  return !l.art14NoticeAt && !!d && d < today;
}

// ───────────── Einwilligung je Kanal ─────────────

export const CONSENT_CHANNELS = ["email", "phone"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const isConsentChannel = (v: unknown): v is ConsentChannel => v === "email" || v === "phone";
export const CHANNEL_LABEL: Record<ConsentChannel, string> = { email: "E-Mail", phone: "Telefon" };

/** Erteilungsweg der Einwilligung */
export const CONSENT_KINDS = ["email", "formular", "schriftlich", "persoenlich", "telefon"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const isConsentKind = (v: unknown): v is ConsentKind => typeof v === "string" && (CONSENT_KINDS as readonly string[]).includes(v);

export const CONSENT_KIND_LABEL: Record<ConsentKind, string> = {
  email: "per E-Mail",
  formular: "Kontaktformular (Website)",
  schriftlich: "schriftlich (Brief, unterschriebenes Formular)",
  persoenlich: "persönlich (z. B. Messe)",
  telefon: "telefonisch",
};

type ConsentFields = {
  consentEmailAt: Date | string | null;
  consentEmailRevokedAt?: Date | string | null;
  consentPhoneAt?: Date | string | null;
  consentPhoneRevokedAt?: Date | string | null;
};

/** Gültig = erteilt und nicht widerrufen */
export const emailConsentValid = (l: ConsentFields) => !!l.consentEmailAt && !l.consentEmailRevokedAt;
export const phoneConsentValid = (l: ConsentFields) => !!l.consentPhoneAt && !l.consentPhoneRevokedAt;
export const anyConsentValid = (l: ConsentFields) => emailConsentValid(l) || phoneConsentValid(l);

/** Hinweis zur Kontaktaufnahme (Liste und Detail), solange nicht für beide Kanäle eine Einwilligung vorliegt */
export const NO_CONSENT_CONTACT_HINT =
  "Werbung per E-Mail nur mit vorheriger ausdrücklicher Einwilligung in E-Mails (§ 7 Abs. 2 Nr. 2 UWG). Werbeanrufe nur mit vorheriger ausdrücklicher Einwilligung in Anrufe (§ 7 Abs. 2 Nr. 1 UWG). Auf eine „mutmaßliche Einwilligung“ stützen wir uns bewusst nicht. Kaltanrufe sind nicht erlaubt. Die Einwilligung gilt nur für den Kanal, für den sie erteilt wurde.";

/**
 * Bestandskunde für den LÖSCHLAUF (vorsichtig): Status „Kunde“ oder irgendeine zugeordnete registrierte Praxis
 * (Stufe „Kunde“ = bezahltes Abo, Stufe „Test“ = registriert, siehe deriveStage in ./pipeline.ts) – auch unsichere
 * Domain-Treffer schonen den Eintrag, damit nie eine Kundin versehentlich gelöscht wird.
 */
export const isExistingCustomerForRetention = (l: { status: string; stage?: string | null }) => l.status === "kunde" || l.stage === "kunde" || l.stage === "test";

/**
 * Bestandskunde für die TELEFON-Anzeige (streng): Status „Kunde“ oder eine sicher zugeordnete registrierte Praxis
 * (persönlicher Code oder gleiche E-Mail); ein unsicherer Domain-Treffer zählt nur bei bezahltem Abo (converted).
 */
export const isExistingCustomerForPhone = (l: { status: string; org?: { via: string; converted: boolean } | null }) =>
  l.status === "kunde" || (!!l.org && (l.org.via !== "domain" || l.org.converted));

/** Telefonnummer nur mit gültiger Telefon-Einwilligung oder bei Bestandskunden (streng) anzeigen. */
export const phoneVisible = (l: ConsentFields & { status: string; org?: { via: string; converted: boolean } | null }) => phoneConsentValid(l) || isExistingCustomerForPhone(l);

// ───────────── Datenschutzhinweis nach Art. 14 DSGVO (Entwurf) ─────────────

/** Nur in der Ansicht – steht NICHT im kopierten bzw. heruntergeladenen Brieftext */
export const ART14_DRAFT_MARK = "ENTWURF – vor Verwendung rechtlich prüfen lassen";

export type Art14Values = { quelle?: string | null; abrufdatum?: string | null; loeschdatum?: string | null };

/** Optionale Platzhalter: leer = entfällt (samt Leerzeichen davor), sonst mit Vorsatz eingefügt */
export const ART14_OPTIONAL_PLACEHOLDER = "ggf. Druck- und Versanddienstleister";
export const ART14_MAIL_PLACEHOLDER = "E-Mail-Dienstleister";
export const ART14_OPTIONAL: Record<string, (v: string) => string> = {
  [ART14_MAIL_PLACEHOLDER]: (v) => `; E-Mail-Dienstleister ${v}`,
  [ART14_OPTIONAL_PLACEHOLDER]: (v) => `; ${v}`,
};

export const ART14_OBJECTION =
  "Ihr Widerspruchsrecht (Art. 21 Abs. 2 DSGVO): Sie können der Verwendung Ihrer Daten für Werbung jederzeit ohne Angabe von Gründen widersprechen. Eine formlose Nachricht an {{Firma}} genügt, per E-Mail an {{E-Mail}} oder per Brief an die Anschrift im Briefkopf. Wir verwenden Ihre Daten dann nicht mehr für Werbung und löschen sie (siehe Speicherdauer).";

const BOX = "=".repeat(60);

/**
 * Vorlage für den ersten Kontakt per Brief. Widerspruchsrecht als hervorgehobener Kasten ganz oben (getrennt von den
 * Ziffern). Platzhalter in {{…}}; Quelle, Abrufdatum und Löschdatum werden auf Wunsch je Praxis eingesetzt, die übrigen
 * (Firma, E-Mail, Datenschutzkontakt, Aufsichtsbehörde, Dienstleister) füllt die Ansicht (fillPlaceholders).
 */
export function art14Text(v: Art14Values = {}): string {
  const quelle = v.quelle?.trim() || "{{Quelle: OpenStreetMap bzw. Impressum Ihrer Praxis-Website}}";
  const abruf = v.abrufdatum?.trim() || "{{Abrufdatum}}";
  const loesch = v.loeschdatum?.trim() || "{{Löschdatum}}";
  return [
    BOX,
    ART14_OBJECTION,
    BOX,
    "",
    "Datenschutzhinweis nach Art. 14 DSGVO",
    "Information über die Verarbeitung Ihrer Daten, die wir nicht bei Ihnen erhoben haben",
    "",
    "1. Verantwortlicher",
    "Verantwortlich für die Verarbeitung ist {{Firma}} (Anschrift und Kontaktdaten siehe Briefkopf). Eine Pflicht zur Benennung eines Datenschutzbeauftragten besteht nicht. Ihre Anfragen richten Sie an {{Datenschutzkontakt}}.",
    "",
    "2. Welche Daten wir verarbeiten",
    "Name und Anschrift Ihrer Praxis, bei Einzelpraxen damit auch der Name der Inhaberin oder des Inhabers; soweit dort veröffentlicht: Name einer Ansprechperson, geschäftliche E-Mail-Adresse, Telefonnummer und Website; die Entfernung Ihrer Praxis zu unserem Standort; Quelle und Abrufdatum; Datum und Inhalt unserer Schreiben, gegebenenfalls Ihre Antwort und Notizen dazu sowie Vermerke über eine Einwilligung und deren Widerruf.",
    "",
    "3. Zweck und Rechtsgrundlage",
    "Wir verarbeiten diese Daten, um Ihnen per Brief Informationen zu unserer Praxissoftware zu senden, eine Antwort von Ihnen zuordnen zu können und doppelte Anschreiben zu vermeiden. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse ist es, Praxen auf unser Angebot aufmerksam zu machen (Direktwerbung). Werbe-E-Mails und Werbeanrufe erhalten Sie von uns nur, wenn Sie vorher ausdrücklich eingewilligt haben.",
    "",
    "4. Quelle der Daten",
    `Die Daten stammen aus öffentlich zugänglichen Quellen: ${quelle}, abgerufen am ${abruf}.`,
    "",
    "5. Empfänger",
    `Wir verkaufen oder vermieten Ihre Daten nicht. Zugriff haben nur Dienstleister, die in unserem Auftrag und nach unserer Weisung tätig sind (Art. 28 DSGVO): Hosting in Deutschland {{${ART14_MAIL_PLACEHOLDER}}} {{${ART14_OPTIONAL_PLACEHOLDER}}}. Eine Übermittlung in Länder außerhalb der EU bzw. des EWR findet nicht statt.`,
    "",
    "6. Speicherdauer",
    `Wir löschen Ihre Daten automatisch am ${loesch}. Unsere Schreiben und Ihre Antworten verlängern diese Frist nicht. Haben Sie in Werbe-E-Mails oder Werbeanrufe eingewilligt, speichern wir Ihre Daten bis 24 Monate nach Ihrer letzten Antwort oder Einwilligung. Widerrufen Sie Ihre Einwilligung, löschen wir am ${loesch} oder, wenn dieser Tag schon vorbei ist, umgehend. Werden Sie Kundin oder Kunde, gelten die Fristen unseres Vertrags und die gesetzlichen Aufbewahrungsfristen. Widersprechen Sie, löschen wir Ihre Daten unverzüglich. Damit wir Sie danach nicht erneut anschreiben, speichern wir Ihre E-Mail-Adresse, Ihre Website-Adresse sowie Praxisname und Postleitzahl nur noch als nicht umkehrbaren Prüfwert (nicht im Klartext) in einer Sperrliste. Rechtsgrundlage ist unser berechtigtes Interesse, Ihren Widerspruch dauerhaft zu beachten (Art. 6 Abs. 1 lit. f DSGVO). Die Sperrliste löschen wir, sobald wir keine Vertriebsschreiben mehr versenden.`,
    "",
    "7. Ihr Widerspruchsrecht",
    "Siehe den hervorgehobenen Hinweis am Anfang dieses Schreibens (Art. 21 Abs. 2 DSGVO).",
    "",
    "8. Ihre weiteren Rechte",
    "Ihre weiteren Rechte: Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18) und Beschwerde bei einer Aufsichtsbehörde (Art. 77), z. B. bei {{Aufsichtsbehörde}}. Haben Sie eine Einwilligung erteilt, können Sie diese jederzeit mit Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3 DSGVO).",
    "",
    "Eine automatisierte Entscheidungsfindung einschließlich Profiling findet nicht statt.",
  ].join("\n");
}

/** Offene Platzhalter {{…}} in Reihenfolge des ersten Auftretens (ohne Doppelte) */
export function openPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]))];
}

/**
 * Platzhalter einsetzen. Werte ohne Inhalt (nur Leerzeichen) bleiben offen – außer bei den optionalen Platzhaltern
 * (Dienstleister, ART14_OPTIONAL): "" = entfällt samt Leerzeichen davor, sonst mit Vorsatz („; …“); undefined = offen.
 */
export function fillPlaceholders(text: string, values: Record<string, string | undefined>): string {
  return text.replace(/( ?)\{\{([^{}]+)\}\}/g, (all, space: string, key: string) => {
    const v = values[key];
    const optional = ART14_OPTIONAL[key];
    if (optional) {
      if (v === undefined) return all;
      return v.trim() ? optional(v.trim()) : "";
    }
    return v?.trim() ? `${space}${v.trim()}` : all;
  });
}
