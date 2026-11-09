/**
 * Sammelrechnung zum Jahresende: Viele Kund:innen bekommen im Dezember eine Sammelrechnung über alle Behandlungen
 * des Jahres (Anzahlungen per Quittung werden angerechnet). Reine Funktionen ohne Server-Importe.
 */

/** Ab diesem Tag (MM-TT) erinnert /heute an die noch offenen Sammelrechnungen des laufenden Jahres. */
export const COLLECTIVE_REMINDER_FROM = "12-01";

/**
 * Für welches Jahr soll /heute an offene Sammelrechnungen erinnern? Ab 1. Dezember an das laufende Jahr,
 * im Januar noch an das Vorjahr (Nachzügler), sonst gar nicht (null).
 */
export function collectiveReminderYear(todayIso: string): number | null {
  const year = Number(todayIso.slice(0, 4));
  const md = todayIso.slice(5, 10);
  if (md >= COLLECTIVE_REMINDER_FROM) return year;
  if (md.startsWith("01-")) return year - 1;
  return null;
}

/** Jahr aus einem Suchparameter (nur 2000 … aktuelles Jahr + 1), sonst `fallback`. */
export function parseYear(v: unknown, fallback: number): number {
  const n = typeof v === "string" && /^\d{4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 2000 && n <= fallback + 1 ? n : fallback;
}

export type UnbilledLine = {
  treatmentRecordId: string | null;
  appointmentId: string | null;
  serviceId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number | null;
  vatRate: number;
};

/** Geschätzter Betrag der vorgeschlagenen Positionen (Positionen ohne Preis zählen 0). */
export const estimateCents = (lines: Pick<UnbilledLine, "quantity" | "unitPriceCents">[]) =>
  lines.reduce((s, l) => s + Math.round((l.unitPriceCents ?? 0) * l.quantity), 0);
