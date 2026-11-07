/**
 * Versionierte Regeln zur Fotodokumentation bei Nagelkorrekturspangen.
 * Grundlage: Leistungsbeschreibung zum Vertrag nach § 125 SGB V Podologie / HeilM-RL (UI1/UI2).
 * ⚠️ Vor Produktivbetrieb gegen die aktuell gültige Lesefassung prüfen (Stand der Verträge 2025 geändert).
 * Ein fehlendes Pflichtfoto blockiert NICHT, sondern verlangt eine Begründung (Review-Ergebnis 15.1).
 */
export const BRACE_RULES_VERSION = "2025-07";

export type BraceAction = "none" | "set" | "check" | "complication" | "remove";

export function requiredBracePhoto(action: BraceAction): string | null {
  switch (action) {
    case "set":
      return "brace_before";
    case "complication":
      return "brace_complication";
    case "remove":
      return "brace_after";
    default:
      return null;
  }
}

export function checkBracePhotos(action: BraceAction, uploadedPurposes: string[], missingReason?: string | null) {
  const required = requiredBracePhoto(action);
  if (!required || uploadedPurposes.includes(required)) return { ok: true as const };
  if (missingReason && missingReason.trim().length >= 5) return { ok: true as const, missing: required };
  return { ok: false as const, missing: required };
}
