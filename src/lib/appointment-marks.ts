/**
 * Kalender – Symbole im Termin-Block (unten rechts): „N“ Neupatient:in, „R“ Rechnung offen (grau) bzw. geschrieben (grün).
 * Reine Logik ohne DB; die Abfrage (eine für alle Termine der Ansicht, keine N+1) steht in src/server/appointment-marks.ts.
 *
 * Neupatient:in („N“): Der Termin gehört zu einer Person, die vor diesem Termin noch nie in der Praxis war, d. h. es gibt
 *   - keinen früheren Termin derselben Person in dieser Praxis, der nicht abgesagt und nicht „nicht erschienen“ ist
 *     (geplante/bestätigte frühere Termine zählen mit – bei einer Terminserie trägt nur der erste Termin das N),
 *   - keine frühere dokumentierte Behandlung (treatment_records) und
 *   - keine Übernahme aus der Vorgänger-Software (Excel-Import, patients.external_ids.legacyExcel) – dort war die Person
 *     schon Patient:in, auch wenn PodoHero ihre früheren Termine nicht kennt.
 *   Abgesagte Termine tragen kein N.
 *
 * Rechnung („R“): nur bei Terminen mit Patient:in, die erledigt sind oder (geplant/bestätigt) bereits vorbei sind – nicht bei
 *   abgesagten oder nicht wahrgenommenen. „geschrieben“ = der Termin steht auf einem ausgestellten Beleg (Rechnung,
 *   Quittung …; nicht Entwurf, nicht storniert, keine Gutschrift) – dieselbe Regel wie „abgerechnet“ beim Verschieben.
 */

export type InvoiceMark = "open" | "written";
export type AppointmentMark = { newPatient: boolean; invoice: InvoiceMark | null };

export type MarkInput = { status: string; endsAt: Date; patientId: string | null };

/** Kommt der Termin für „R“ in Frage (wahrgenommen bzw. vorbei, mit Patient:in)? */
export function invoiceRelevant(a: MarkInput, now: Date): boolean {
  if (!a.patientId) return false;
  if (a.status === "done") return true;
  if (a.status === "cancelled" || a.status === "no_show") return false;
  return a.endsAt.getTime() <= now.getTime();
}

/** Symbole eines Termins aus den Abfrage-Ergebnissen (`newPatient`: Termin ist erster Besuch, `billed`: auf ausgestelltem Beleg) */
export function markFor(a: MarkInput, now: Date, newPatient: boolean, billed: boolean): AppointmentMark {
  return {
    newPatient: !!a.patientId && a.status !== "cancelled" && newPatient,
    invoice: invoiceRelevant(a, now) ? (billed ? "written" : "open") : null,
  };
}

/** Beschriftung für Bildschirmleser/Tooltip */
export const MARK_LABELS = {
  newPatient: "Neupatient:in",
  open: "Rechnung offen",
  written: "Rechnung geschrieben",
} as const;
