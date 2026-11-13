/**
 * Wann ist eine Anzahlung (Vorauszahlung, Belegart „deposit“/AZ) erlaubt? Nur vor der Behandlung: ohne Termin oder für
 * einen Termin ab morgen (Kalendertag in Berlin), und nie für eine schon dokumentierte Behandlung. Für erbrachte
 * Behandlungen gibt es die Quittung. Gilt im Server (createDeposit) und für die Buttons (Terminseite, Anzahlungsseite).
 */
export function depositAllowed(p: { appointmentDay: string | null; today: string; hasRecord: boolean }): boolean {
  if (p.hasRecord) return false;
  return !p.appointmentDay || p.appointmentDay > p.today;
}
