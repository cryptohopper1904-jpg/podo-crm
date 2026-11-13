/** Termindauer in Minuten: dieselben Grenzen wie in Formular und Verschieben (5–480). */
export const APPOINTMENT_DURATION_MIN = 5;
export const APPOINTMENT_DURATION_MAX = 480;
const FALLBACK = 30;

/**
 * Dauer serverseitig auf 5–480 Minuten begrenzen (ganzzahlig). Die Summe mehrerer Leistungsdauern
 * kann sonst über 8 Stunden liegen; ungültige Werte fallen auf 30 Minuten zurück.
 */
export function clampDurationMin(n: number): number {
  if (!Number.isFinite(n)) return FALLBACK;
  return Math.min(APPOINTMENT_DURATION_MAX, Math.max(APPOINTMENT_DURATION_MIN, Math.round(n)));
}
