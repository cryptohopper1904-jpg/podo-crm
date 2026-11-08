export type PatientStatus = "new" | "active" | "overdue" | "inactive";

export const STATUS_LABEL: Record<PatientStatus, string> = {
  new: "Neu",
  active: "Aktiv",
  overdue: "Überfällig",
  inactive: "Inaktiv",
};

/**
 * Status wie im Excel-Rechnungsmanager, aber mit individuellem Intervall:
 * Neu = noch keine Behandlung, Überfällig = Intervall (Standard 6 Wochen) + 2 Wochen überschritten,
 * Inaktiv = länger als 12 Monate nicht da.
 */
export function patientStatus(lastVisit: Date | null, intervalWeeks: number | null, now = new Date()): PatientStatus {
  if (!lastVisit) return "new";
  const days = (now.getTime() - lastVisit.getTime()) / 86400_000;
  if (days > 365) return "inactive";
  const limit = ((intervalWeeks ?? 6) + 2) * 7;
  return days > limit ? "overdue" : "active";
}
