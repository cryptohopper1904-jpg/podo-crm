import { BOOKING_DOCUMENT_YEARS, CASH_RECORD_YEARS, RETENTION_HEMMUNG_NOTE, retentionEnd } from "./retention";

/**
 * Aufbewahrung je Patient:in (Gesamt-Review H3) – reine Logik, Daten liefert src/server/patient-deletion.ts.
 *
 * - Behandlungsdokumentation inkl. Anamnese und Behandlungsfotos: 10 Jahre nach Abschluss der Behandlung
 *   (§ 630f Abs. 3 BGB; maßgeblich ist hier die letzte Behandlung bzw. Anamnese).
 * - Rechnungen und Zahlungsbelege (Buchungsbelege): 8 Jahre ab Ende des Ausstellungsjahres (§ 147 Abs. 3, 4 AO,
 *   § 14b UStG, BEG IV) – Fristen in src/lib/retention.ts.
 * - Kassenvorgänge (Bar/Karte/Gutschein mit TSE-Daten) sind Kassen-Einzelaufzeichnungen: 10 Jahre ab Ende des Jahres.
 * Steuerliche Fristen sind das früheste Ende (Ablaufhemmung § 147 Abs. 3 S. 5 AO).
 *
 * Gibt es solche Daten, ist eine vollständige Löschung (Art. 17 Abs. 3 lit. b DSGVO) ausgeschlossen. Angeboten wird
 * stattdessen das Löschen der Kontaktdaten und der Widerruf aller Marketing-Einwilligungen.
 */
export type RetentionFacts = {
  /** letzte Behandlung (treatment_records.treated_at) */
  lastTreatmentAt: Date | null;
  /** letzte Anamnese */
  lastAnamnesisAt: Date | null;
  /** Fotos/Dokumente, die an einer Behandlung hängen */
  recordMediaCount: number;
  /** letztes Rechnungsdatum bzw. letzter Zahlungsbeleg (issued_at bzw. created_at bei Entwürfen) */
  lastInvoiceAt: Date | null;
  /** letzter Kassenvorgang (Bar/Karte/Gutschein) auf eine Rechnung der Person – Kassen-Einzelaufzeichnung */
  lastRegisterPaymentAt?: Date | null;
};

export type RetentionDecision =
  | { mode: "delete"; reasons: [] ; retainUntil: null }
  | { mode: "anonymize"; reasons: string[]; retainUntil: Date; expired: boolean };

const addYears = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCFullYear(x.getUTCFullYear() + n);
  return x;
};
/** 31.12. des Jahres (Europe/Berlin) + n Jahre, Ende des Tages (vereinfacht UTC) */
const endOfYearPlus = (d: Date, n: number) => new Date(`${retentionEnd(d, n)}T23:59:59Z`);

export function retentionDecision(f: RetentionFacts, now = new Date()): RetentionDecision {
  const reasons: string[] = [];
  const until: Date[] = [];
  const medical = [f.lastTreatmentAt, f.lastAnamnesisAt].filter((d): d is Date => !!d);
  if (medical.length || f.recordMediaCount > 0) {
    reasons.push("Behandlungsdokumentation (§ 630f Abs. 3 BGB: 10 Jahre nach Abschluss der Behandlung)");
    const last = medical.length ? new Date(Math.max(...medical.map((d) => d.getTime()))) : now;
    until.push(addYears(last, 10));
  }
  if (f.lastInvoiceAt) {
    reasons.push(`Rechnungen und Zahlungsbelege (§ 147 AO, § 14b UStG: ${BOOKING_DOCUMENT_YEARS} Jahre ab Ende des Ausstellungsjahres, ${RETENTION_HEMMUNG_NOTE})`);
    until.push(endOfYearPlus(f.lastInvoiceAt, BOOKING_DOCUMENT_YEARS));
  }
  if (f.lastRegisterPaymentAt) {
    reasons.push(`Kassenaufzeichnungen (§ 147 AO, KassenSichV: ${CASH_RECORD_YEARS} Jahre ab Ende des Jahres des Kassenvorgangs)`);
    until.push(endOfYearPlus(f.lastRegisterPaymentAt, CASH_RECORD_YEARS));
  }
  if (!reasons.length) return { mode: "delete", reasons: [], retainUntil: null };
  const retainUntil = new Date(Math.max(...until.map((d) => d.getTime())));
  return { mode: "anonymize", reasons, retainUntil, expired: retainUntil.getTime() < now.getTime() };
}

/** Einwilligungen, die beim Löschen der Kontaktdaten widerrufen werden (Werbung, Kontaktkanäle, Fotos für Werbung). */
export const ERASABLE_CONSENTS = ["photo_marketing", "marketing", "review_request", "whatsapp", "email_reminders", "sms_reminders"] as const;
