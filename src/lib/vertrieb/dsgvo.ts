/**
 * Vertrieb: Vorgaben der Rechtsprüfung (DSGVO/UWG) – rein und testbar.
 * - Herkunft je Lead: Quelle + Abrufdatum (Pflicht beim Import und beim manuellen Anlegen)
 * - Löschfrist: Standard Anlage + 12 Monate, wählbar 6–24 Monate
 * - Einwilligung: nein / ja mit Datum und Art; ohne sie keine Werbe-E-Mails (serverseitig in eligibility()),
 *   keine Anzeige der Telefonnummer (außer Bestandskunde) und ein deutlicher Hinweis
 * - Datenschutzhinweis nach Art. 14 DSGVO als Vorlage für den ersten Kontakt per Brief (Entwurf)
 */
import { berlinDateIso, dateDe } from "@/lib/format";

// ───────────── Löschfrist ─────────────

export const DELETE_MONTHS = { default: 12, min: 6, max: 24 } as const;

export const isDeleteMonths = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= DELETE_MONTHS.min && n <= DELETE_MONTHS.max;

/** n Monate addieren (UTC, unabhängig von der Zeitzone des Servers); Monatsende wird gekappt wie in Postgres. */
export function addMonthsUtc(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/** Löschdatum = Anlage + n Monate (31.08. + 6 Monate = 28./29.02.). */
export function deleteAfterFor(createdAt: Date, months: number): Date {
  if (!isDeleteMonths(months)) throw new Error(`Löschfrist: ${DELETE_MONTHS.min} bis ${DELETE_MONTHS.max} Monate.`);
  return addMonthsUtc(createdAt, months);
}

/** Welche Frist (Monate ab Anlage) ergibt dieses Löschdatum? null, wenn keine ganze Monatszahl im erlaubten Bereich passt. */
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

// ───────────── Einwilligung ─────────────

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

/** Hinweis, solange keine Einwilligung dokumentiert ist (Liste und Detail) */
export const NO_CONSENT_CONTACT_HINT = "Werbe-E-Mails und Werbeanrufe nur mit Einwilligung (§ 7 UWG). Kaltanrufe nicht erlaubt.";

/** Bestandskunde: Status „Kunde“ bzw. Stufe „Kunde“ (registrierte Praxis mit bezahltem Abo) */
export const isExistingCustomer = (l: { status: string; stage?: string | null }) => l.status === "kunde" || l.stage === "kunde";

/** Telefonnummer nur mit Einwilligung („ja“) oder bei Bestandskunden anzeigen. */
export const phoneVisible = (l: { consentAt: Date | string | null; status: string; stage?: string | null }) => !!l.consentAt || isExistingCustomer(l);

// ───────────── Datenschutzhinweis nach Art. 14 DSGVO (Entwurf) ─────────────

export const ART14_DRAFT_MARK = "ENTWURF – vor Verwendung rechtlich prüfen lassen";

export type Art14Values = { quelle?: string | null; abrufdatum?: string | null; loeschdatum?: string | null };

/**
 * Vorlage für den ersten Kontakt per Brief. Platzhalter in {{…}}; {{Firma}} bleibt immer stehen (Verantwortlicher),
 * Quelle, Abrufdatum und Löschdatum werden auf Wunsch je Praxis eingesetzt.
 */
export function art14Text(v: Art14Values = {}): string {
  const quelle = v.quelle?.trim() || "{{Quelle: OpenStreetMap bzw. Impressum Ihrer Praxis-Website}}";
  const abruf = v.abrufdatum?.trim() || "{{Abrufdatum}}";
  const loesch = v.loeschdatum?.trim() || "{{Löschdatum}}";
  return [
    ART14_DRAFT_MARK,
    "",
    "Datenschutzhinweis nach Art. 14 DSGVO",
    "Information über die Verarbeitung Ihrer Daten, die wir nicht bei Ihnen erhoben haben",
    "",
    "1. Verantwortlicher",
    "Verantwortlich für die Verarbeitung ist {{Firma}} (Anschrift und Kontaktdaten siehe Briefkopf). Datenschutzkontakt: {{Datenschutzkontakt}}.",
    "",
    "2. Welche Daten wir verarbeiten",
    "Name und Anschrift Ihrer Praxis sowie – soweit dort veröffentlicht – geschäftliche E-Mail-Adresse, Telefonnummer und Website.",
    "",
    "3. Zweck und Rechtsgrundlage",
    "Wir verarbeiten diese Daten, um Ihnen per Brief Informationen zu unserer Praxissoftware zu senden und eine Antwort von Ihnen zuordnen zu können. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse ist es, Praxen auf unser Angebot aufmerksam zu machen (Direktwerbung). Werbe-E-Mails und Werbeanrufe erhalten Sie von uns nur, wenn Sie vorher ausdrücklich eingewilligt haben.",
    "",
    "4. Quelle der Daten",
    `Die Daten stammen aus öffentlich zugänglichen Quellen: ${quelle}, abgerufen am ${abruf}.`,
    "",
    "5. Empfänger",
    "Wir geben Ihre Daten nicht an Dritte weiter. Technische Dienstleister (z. B. für das Hosting) verarbeiten sie nur in unserem Auftrag und nach unserer Weisung (Art. 28 DSGVO).",
    "",
    "6. Speicherdauer",
    `Wir speichern Ihre Daten bis zum ${loesch}, höchstens 24 Monate ab Erhebung. Werden Sie Kundin oder Kunde oder willigen Sie in weitere Informationen ein, gelten die dafür maßgeblichen Fristen. Widersprechen Sie, löschen wir Ihre Daten unverzüglich. Damit wir Sie danach nicht erneut ansprechen, behalten wir nur einen nicht umkehrbaren Prüfwert (Sperrliste).`,
    "",
    "7. Ihr Widerspruchsrecht (Art. 21 DSGVO)",
    "Sie können der Verarbeitung Ihrer Daten für Zwecke der Direktwerbung jederzeit ohne Angabe von Gründen widersprechen (Art. 21 Abs. 2 DSGVO). Eine formlose Nachricht an {{Firma}} genügt, z. B. per E-Mail an {{E-Mail}} oder per Brief. Wir verwenden Ihre Daten dann nicht mehr für Werbung und löschen sie.",
    "",
    "8. Ihre weiteren Rechte",
    "Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18) und Datenübertragbarkeit (Art. 20). Sie können sich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), z. B. bei {{Aufsichtsbehörde}}.",
    "",
    "Eine automatisierte Entscheidungsfindung einschließlich Profiling findet nicht statt.",
  ].join("\n");
}
