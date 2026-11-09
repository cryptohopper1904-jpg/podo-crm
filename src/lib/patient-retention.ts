/**
 * Aufbewahrung je Kund:in (Gesamt-Review H3) – reine Logik, Daten liefert src/server/patient-deletion.ts.
 *
 * - Behandlungsdokumentation inkl. Anamnese und Behandlungsfotos: 10 Jahre nach Abschluss der Behandlung
 *   (§ 630f Abs. 3 BGB; maßgeblich ist hier die letzte Behandlung bzw. Anamnese).
 * - Rechnungen: 10 Jahre ab Ende des Kalenderjahres, in dem die Rechnung ausgestellt wurde (§ 147 Abs. 3, 4 AO, § 14b UStG).
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
  /** letztes Rechnungsdatum (issued_at bzw. created_at bei Entwürfen) */
  lastInvoiceAt: Date | null;
};

export type RetentionDecision =
  | { mode: "delete"; reasons: [] ; retainUntil: null }
  | { mode: "anonymize"; reasons: string[]; retainUntil: Date; expired: boolean };

const addYears = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCFullYear(x.getUTCFullYear() + n);
  return x;
};
/** 31.12. des Jahres + n Jahre (Ende des Tages, Europe/Berlin vereinfacht als UTC-Jahresende) */
const endOfYearPlus = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear() + n, 11, 31, 23, 59, 59));

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
    reasons.push("Rechnungen (§ 147 AO, § 14b UStG: 10 Jahre ab Ende des Ausstellungsjahres)");
    until.push(endOfYearPlus(f.lastInvoiceAt, 10));
  }
  if (!reasons.length) return { mode: "delete", reasons: [], retainUntil: null };
  const retainUntil = new Date(Math.max(...until.map((d) => d.getTime())));
  return { mode: "anonymize", reasons, retainUntil, expired: retainUntil.getTime() < now.getTime() };
}

/** Einwilligungen, die beim Löschen der Kontaktdaten widerrufen werden (Werbung, Kontaktkanäle, Fotos für Werbung). */
export const ERASABLE_CONSENTS = ["photo_marketing", "marketing", "review_request", "whatsapp", "email_reminders", "sms_reminders"] as const;
