/**
 * Kündigung & Löschung einer Praxis (Mandant).
 * Nach dem Antrag (organizations.deletion_requested_at) gilt eine Karenzzeit; erst danach löscht
 * der Betreiber mit scripts/purge-organizations.ts endgültig. Innerhalb der Karenzzeit kann die
 * Praxis den Antrag zurücknehmen.
 */
export const DELETION_GRACE_DAYS = 30;
const DAY = 24 * 3600_000;

export function deletionDueAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * DAY);
}

/** true = Karenzzeit läuft noch (Antrag kann zurückgenommen werden, Löschung noch nicht erlaubt). */
export function isWithinGrace(requestedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() < deletionDueAt(requestedAt).getTime();
}

/** Stichtag für den Löschlauf: Anträge vor diesem Zeitpunkt sind fällig. */
export function purgeCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - DELETION_GRACE_DAYS * DAY);
}

/** Bestätigung „Praxisname eintippen“: Groß-/Kleinschreibung und Leerraum am Rand egal, sonst exakt. */
export function confirmsPracticeName(input: string, practiceName: string): boolean {
  const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
  return norm(input).length > 0 && norm(input) === norm(practiceName);
}

/**
 * Kassen-Hinweise für Ankündigung, Kündigungsbestätigung und „Daten & Kündigung“ (Buchhaltung E2/E5, Recht E-7):
 * DSFinV-K-Export (höchstens 3 Jahre je Export) und TSE-Export (beim TSE-Anbieter) separat erstellen.
 */
export const EXPORT_CASH_NOTE =
  "Hast du die Kasse genutzt, erstelle auch den DSFinV-K-Export – ggf. mehrere Zeiträume (max. 3 Jahre je Export) – und den TSE-Export bei deinem TSE-Anbieter; nach der Löschung lassen sie sich über PodoHero nicht mehr erzeugen.";

/** Abmeldung des Kassensystems beim Finanzamt (§ 146a Abs. 4 AO, Buchhaltung E2) */
export const CASH_REGISTER_NOTE =
  "Hast du deine Kasse beim Finanzamt gemeldet, melde ihre Außerbetriebnahme innerhalb eines Monats (§ 146a Abs. 4 AO, über „Mein ELSTER“); nimm die TSE bei deinem TSE-Anbieter erst nach dem TSE-Export außer Betrieb.";
