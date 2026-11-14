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

/**
 * Abmeldung des Kassensystems beim Finanzamt (§ 146a Abs. 4 AO, Buchhaltung E2, Recht R-2) – für Kündigungsbestätigung und
 * „Daten & Kündigung“. Die Ankündigungs-Mail (Ende des Nur-Lesen-Modus) nutzt CASH_REGISTER_NOTE_ANNOUNCEMENT.
 */
export const CASH_REGISTER_NOTE =
  "Hast du PodoHero als Kasse mit TSE genutzt, teile die Außerbetriebnahme innerhalb eines Monats danach deinem Finanzamt mit (§ 146a Abs. 4 AO, z. B. über „Mein ELSTER“); war die Kasse noch nicht gemeldet, melde Anschaffung und Außerbetriebnahme zusammen. Nimm die TSE bei deinem TSE-Anbieter erst nach dem TSE-Export außer Betrieb und stimme das mit deiner Steuerberatung ab.";

/** Wie CASH_REGISTER_NOTE, für die Ankündigungs-Mail mit „– falls noch nicht geschehen“ (Recht R-2) */
export const CASH_REGISTER_NOTE_ANNOUNCEMENT =
  "Hast du PodoHero als Kasse mit TSE genutzt, teile die Außerbetriebnahme – falls noch nicht geschehen – innerhalb eines Monats danach deinem Finanzamt mit (§ 146a Abs. 4 AO, z. B. über „Mein ELSTER“); war die Kasse noch nicht gemeldet, melde Anschaffung und Außerbetriebnahme zusammen. Nimm die TSE bei deinem TSE-Anbieter erst nach dem TSE-Export außer Betrieb und stimme das mit deiner Steuerberatung ab.";

/**
 * Kassen-Hinweis für die E-Mail an die Steuerberatung (3. Person, Recht R-3): entspricht EXPORT_CASH_NOTE und
 * CASH_REGISTER_NOTE, bezogen auf die Praxis.
 */
export const ACCOUNTANT_CASH_NOTE =
  "Hat die Praxis die Kasse genutzt, sollte sie auch den DSFinV-K-Export – ggf. mehrere Zeiträume (max. 3 Jahre je Export) – und den TSE-Export bei ihrem TSE-Anbieter erstellen und die Außerbetriebnahme innerhalb eines Monats dem Finanzamt mitteilen (§ 146a Abs. 4 AO, z. B. über „Mein ELSTER“; war die Kasse noch nicht gemeldet, zusammen mit der Anschaffung). Nach der Löschung lassen sich die Exporte über PodoHero nicht mehr erzeugen; die TSE sollte sie beim TSE-Anbieter erst nach dem TSE-Export außer Betrieb nehmen.";

/** Ab hier gilt ein Löschantrag als überfällig (Health-Check): Karenzzeit + 14 Tage (AGB § 9 Nr. 2: „spätestens 14 Tage danach“) */
export const DELETION_OVERDUE_DAYS = DELETION_GRACE_DAYS + 14;

/** Stichtag für überfällige Löschanträge: Anträge vor diesem Zeitpunkt hätten gelöscht sein müssen. */
export function overdueCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - DELETION_OVERDUE_DAYS * DAY);
}

/**
 * Hinweis für den Betreiber: Der Löschlauf hat mit dem Stripe-Abschluss begonnen (settings.purgeStartedAt), die Praxis
 * besteht aber noch (Abbruch danach). null = kein begonnener Löschlauf.
 */
export function purgeStartedProblem(settings: Record<string, unknown> | null | undefined): string | null {
  const at = settings?.purgeStartedAt;
  return typeof at === "string" ? "Löschlauf begonnen (Stripe-Abo/-Kunde ggf. schon beendet), Praxis noch vorhanden – Löschlauf wiederholen bzw. von Hand klären" : null;
}
