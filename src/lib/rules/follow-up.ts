/**
 * Folgeverordnung (GKV Paket B Teil 2) – reine Regeln. Nach dem Ende einer Verordnung braucht es bei weiterem
 * Behandlungsbedarf eine neue (Folge-)Verordnung der Ärztin/des Arztes; PodoHero erinnert daran und bereitet die
 * Anforderung vor. Keine Frist/Regel aus dem Vertrag – reiner Praxis-Hinweis (docs/GKV.md, Paket B).
 */

/**
 * beendet: Behandlung abgeschlossen. „Korrektur nötig“ (GKV Paket C) gehört dazu – es ist eine abgerechnete Verordnung,
 * an der nur die Abrechnung korrigiert wird (Absetzung/Rückläufer); weitere Behandlungen darauf gibt es nicht, also
 * braucht es bei weiterem Bedarf wie bei „abgerechnet“ eine Folgeverordnung.
 */
const ENDED = new Set(["completed", "billing_ready", "billed", "correction_needed"]);
const RUNNING = new Set(["open", "active"]);

export type FollowUpInput = {
  status: string;
  unitsUsed: number;
  unitsRemaining: number;
  /** geplante Termine der Person ab heute */
  futureAppointments: number;
  /** Dauerpatient:in (patients.follow_up_expected) */
  followUpExpected: boolean;
  /** es gibt schon eine neuere laufende Verordnung (offen/in Behandlung) */
  newerPrescription: boolean;
};

export type FollowUpReason = "ended" | "last_unit";

/**
 * „Folgeverordnung anfordern“: Verordnung abgeschlossen/abrechnungsreif/abgerechnet (bzw. Frist überschritten nach
 * mindestens einer Behandlung) oder höchstens noch 1 Einheit offen
 * (nach mindestens einer Behandlung), UND die Person hat weitere Termine oder ist als Dauerpatient:in markiert, UND es
 * gibt noch keine neuere laufende Verordnung. Gibt den Grund zurück oder null.
 */
export function followUpReason(v: FollowUpInput): FollowUpReason | null {
  if (v.newerPrescription) return null;
  if (!(v.futureAppointments > 0 || v.followUpExpected)) return null;
  if (ENDED.has(v.status)) return "ended";
  // Frist überschritten nach mindestens einer Behandlung: Verordnung ist beendet (Review R2-23)
  if (v.status === "expired" && v.unitsUsed > 0) return "ended";
  if (RUNNING.has(v.status) && v.unitsUsed > 0 && v.unitsRemaining <= 1) return "last_unit";
  return null;
}

export const FOLLOW_UP_HINT: Record<FollowUpReason, string> = {
  ended: "Verordnung beendet – Folgeverordnung anfordern",
  last_unit: "Letzte Einheit – Folgeverordnung anfordern",
};

/**
 * Hinweis beim Planen eines Termins ohne laufende Verordnung, wenn die letzte Verordnung der Person beendet ist
 * (planningWarnings-Ergänzung). `lastDate`: letzter Behandlungstag der beendeten Verordnung.
 */
export function afterPrescriptionWarning(input: { lastPrescription: { issuedAt: string; status: string; lastDate: string | null } | null; newDates: string[] }): string | null {
  const last = input.lastPrescription;
  if (!last || !input.newDates.length) return null;
  if (!ENDED.has(last.status) && last.status !== "expired") return null;
  const de = (iso: string) => iso.split("-").reverse().join(".");
  const after = [...input.newDates].sort().filter((d) => !last.lastDate || d > last.lastDate);
  if (!after.length) return null;
  return `Termin ${de(after[0])} nach Ende der Verordnung vom ${de(last.issuedAt)}${last.lastDate ? ` (letzte Behandlung ${de(last.lastDate)})` : ""} – keine neue Verordnung vorhanden. Bitte Folgeverordnung anfordern (sonst Behandlung als Selbstzahler).`;
}

/** Brieftext „Anforderung Folgeverordnung“ (PDF und Textvorlage nutzen denselben Wortlaut) */
export function followUpLetter(input: {
  practice: string;
  doctorName: string | null;
  patient: { name: string; birthDate: string | null; insuranceNumber: string | null; insurerName: string | null };
  prescription: { issuedAt: string; diagnosisGroup: string; icd10: string | null; icd10Second?: string | null; diagnosisText?: string | null; positions: { position?: string; label: string; units: number }[]; units: number };
  treatmentDates: string[];
  report: { reportDate: string; course: string | null; result: string | null; recommendation: string | null } | null;
  today: string;
}): { subject: string; paragraphs: string[] } {
  const de = (iso: string) => iso.split("-").reverse().join(".");
  const p = input.patient;
  const vo = input.prescription;
  const dates = [...input.treatmentDates].sort();
  const diagnosis = [vo.diagnosisGroup, vo.icd10 ? `ICD-10 ${vo.icd10}` : null, vo.icd10Second ? vo.icd10Second : null, vo.diagnosisText].filter(Boolean).join(", ");
  const paragraphs = [
    `${input.doctorName ? `Sehr geehrte/r ${input.doctorName}` : "Sehr geehrte Damen und Herren"},`,
    `für ${p.name}${p.birthDate ? `, geb. ${de(p.birthDate)}` : ""}${p.insurerName ? `, ${p.insurerName}` : ""}${p.insuranceNumber ? `, Vers.-Nr. ${p.insuranceNumber}` : ""}, bitten wir um eine Folgeverordnung (Heilmittelverordnung Podologie, Muster 13), da weiterhin Behandlungsbedarf besteht.`,
    `Bisherige Verordnung vom ${de(vo.issuedAt)}: Diagnose ${diagnosis || "–"}; Heilmittel ${vo.positions.map((x) => `${x.position ? `${x.position} ` : ""}${x.label} × ${x.units}`).join(", ") || `${vo.units} Einheiten`}.`,
    dates.length
      ? `Behandelt an ${dates.length} ${dates.length === 1 ? "Tag" : "Tagen"} (${de(dates[0])}${dates.length > 1 ? ` bis ${de(dates.at(-1)!)}` : ""}) von ${vo.units} verordneten Einheiten.`
      : "Auf diese Verordnung ist noch keine Behandlung dokumentiert.",
  ];
  if (input.report) {
    const r = input.report;
    const parts = [r.course ? `Verlauf: ${r.course}` : null, r.result ? `Ergebnis: ${r.result}` : null, r.recommendation ? `Empfehlung: ${r.recommendation}` : null].filter(Boolean);
    if (parts.length) paragraphs.push(`Aus unserem Therapiebericht vom ${de(r.reportDate)}: ${parts.join(" ")}`);
  }
  paragraphs.push("Vielen Dank für Ihre Unterstützung.", `Mit freundlichen Grüßen\n${input.practice}`);
  return { subject: `Anforderung einer Folgeverordnung (Podologie) – ${p.name}`, paragraphs };
}
