/** Termindauer in Minuten: dieselben Grenzen wie in Formular und Verschieben (5–480). */
export const APPOINTMENT_DURATION_MIN = 5;
export const APPOINTMENT_DURATION_MAX = 480;
export const DURATION_RANGE_ERROR = "Dauer muss zwischen 5 und 480 Minuten liegen.";

/** Ganze Minuten zwischen 5 und 480 (keine stille Begrenzung – Aufrufer meldet einen Fehler). */
export function isValidDurationMin(n: number): boolean {
  return Number.isInteger(n) && n >= APPOINTMENT_DURATION_MIN && n <= APPOINTMENT_DURATION_MAX;
}

/**
 * Dauer aus der Summe der gewählten Leistungen (ohne eigene Eingabe). Unter 5 Minuten (oder ohne Dauer) → 5 bzw. 30;
 * über 480 Minuten → Fehlermeldung, damit nicht still gekürzt wird.
 */
export function durationFromServices(sumMin: number): { ok: true; durationMin: number } | { ok: false; error: string } {
  if (!sumMin) return { ok: true, durationMin: 30 };
  if (sumMin > APPOINTMENT_DURATION_MAX) {
    return { ok: false, error: `Die gewählten Leistungen ergeben ${sumMin} Minuten (höchstens ${APPOINTMENT_DURATION_MAX}). Bitte Dauer eintragen oder auf zwei Termine aufteilen.` };
  }
  return { ok: true, durationMin: Math.max(APPOINTMENT_DURATION_MIN, sumMin) };
}
