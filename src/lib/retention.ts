/**
 * Steuerliche Aufbewahrungsfristen für Belege (reine Funktionen, zur Laufzeit berechnet – bewusst nicht als fester
 * Wert gespeichert, weil sich Fristen ändern und die Ablaufhemmung im Einzelfall gilt).
 *
 * - Buchungsbelege (Rechnungen, Quittungen, Anzahlungen, Stornorechnungen, Zahlungsbelege): 8 Jahre
 *   (§ 147 Abs. 1 Nr. 4, Abs. 3 AO, § 14b Abs. 1 UStG in der Fassung des BEG IV, seit 01.01.2025).
 * - Kassen-Einzelaufzeichnungen (Kassenvorgänge mit TSE-Daten, DSFinV-K-/TSE-Export): 10 Jahre
 *   (Aufzeichnungen nach § 147 Abs. 1 Nr. 1, Abs. 3 AO).
 * Die Frist beginnt mit dem Schluss des Kalenderjahres, in dem der Beleg entstanden ist (§ 147 Abs. 4 AO).
 * Sie läuft nicht ab, soweit und solange die Unterlagen für noch nicht festsetzungsverjährte Steuern von Bedeutung
 * sind (Ablaufhemmung, § 147 Abs. 3 S. 5 AO) – das errechnete Datum ist daher das FRÜHESTE Ende der Aufbewahrung.
 * Patientenakten (§ 630f Abs. 3 BGB, 10 Jahre nach Abschluss der Behandlung) regelt src/lib/patient-retention.ts.
 */
export const BOOKING_DOCUMENT_YEARS = 8;
export const CASH_RECORD_YEARS = 10;

export const RETENTION_HEMMUNG_NOTE = "vorbehaltlich der Ablaufhemmung nach § 147 Abs. 3 S. 5 AO";

/** Kalenderjahr in Berlin (YYYY-MM-DD-Text: direkt, Zeitpunkt: Europe/Berlin) */
function berlinYear(d: string | Date): number {
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)) return Number(d.slice(0, 4));
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date(d)));
}

/** Ende der Aufbewahrung (31.12. des Jahres + n), als YYYY-MM-DD – frühestes Ende, siehe Ablaufhemmung. */
export function retentionEnd(issuedAt: string | Date, years: number): string {
  return `${berlinYear(issuedAt) + years}-12-31`;
}

/** Buchungsbeleg (Rechnung, Quittung, Zahlungsbeleg …): 8 Jahre ab Ende des Ausstellungsjahres */
export const bookingDocumentRetentionEnd = (issuedAt: string | Date) => retentionEnd(issuedAt, BOOKING_DOCUMENT_YEARS);
/** Kassen-Einzelaufzeichnung (Kassenvorgang mit TSE-Daten): 10 Jahre ab Ende des Jahres */
export const cashRecordRetentionEnd = (at: string | Date) => retentionEnd(at, CASH_RECORD_YEARS);
