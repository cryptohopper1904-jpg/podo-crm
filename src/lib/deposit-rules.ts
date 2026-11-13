/**
 * Regeln für Anzahlungen (Vorauszahlung, Belegart „deposit“/AZ) – reine Funktionen, im Server und im Browser nutzbar.
 */

/**
 * Wann ist eine Anzahlung erlaubt? Nur vor der Behandlung: ohne Termin oder für einen Termin ab morgen (Kalendertag in
 * Berlin), und nie für eine schon dokumentierte Behandlung. Für erbrachte Behandlungen gibt es die Quittung. Gilt im
 * Server (createDeposit) und für die Buttons (Terminseite, Anzahlungsseite).
 */
export function depositAllowed(p: { appointmentDay: string | null; today: string; hasRecord: boolean }): boolean {
  if (p.hasRecord) return false;
  return !p.appointmentDay || p.appointmentDay > p.today;
}

type DepositRef = {
  appointmentId: string | null;
  treatmentRecordId: string | null;
  issuedAt: string | null;
  serviceDay?: string | null;
  appointmentMissed?: boolean;
};

/** Ist die Leistung zur Anzahlung erbracht (verknüpfter Termin/Doku-Eintrag bis heute)? Ohne Bezug: unbekannt → nein. */
export const depositServiceDone = (d: Pick<DepositRef, "serviceDay">, today: string): boolean => !!d.serviceDay && d.serviceDay <= today;

/**
 * Anzahlung zu einem künftigen Termin: erst nach dem Termin anrechenbar (der Server lehnt Positionen mit künftigem
 * Termin ab) – in der Auswahl deaktiviert.
 */
export const depositNotYetCreditable = (d: Pick<DepositRef, "serviceDay">, today: string): boolean => !!d.serviceDay && d.serviceDay > today;

/**
 * Hinweis an einer Anzahlung in der Auswahl der (Sammel-)Rechnung, wenn die Leistung (noch) nicht belegt erbracht ist –
 * solche Anzahlungen sind nicht vorausgewählt.
 */
export function depositCheckHint(d: DepositRef, today: string): string | null {
  if (depositServiceDone(d, today)) return null;
  if (d.appointmentMissed) return "Termin abgesagt/versäumt – bitte prüfen, ggf. erstatten";
  if (depositNotYetCreditable(d, today)) return "erst nach dem Termin anrechenbar";
  if (!d.appointmentId && !d.treatmentRecordId) return "ohne Termin – Leistung erbracht? Bitte prüfen (und nicht doppelt als Position)";
  return "Leistung erbracht? Bitte prüfen";
}

/**
 * Vorauswahl einer offenen Anzahlung im Rechnungsformular (künftige Termine nie – erst nach dem Termin anrechenbar):
 *  - Rechnung/Sammelrechnung aus genau diesem Termin bzw. dieser Behandlung (Vorlage): immer (nie doppelt kassieren)
 *  - Sammelrechnung: nur Anzahlungen aus dem Jahr der Sammelrechnung, deren verknüpfte Leistung bis heute erbracht ist –
 *    Anzahlungen ohne Termin oder zu abgesagten/versäumten Terminen nicht (anwählbar, mit Hinweis)
 */
export function depositPreselected(
  kind: string,
  d: DepositRef,
  ctx: { today: string; receiptsYear?: number | null; presetRefs: ReadonlySet<string> },
): boolean {
  if (kind !== "invoice" && kind !== "collective") return false;
  if (depositNotYetCreditable(d, ctx.today)) return false;
  if ((d.appointmentId && ctx.presetRefs.has(d.appointmentId)) || (d.treatmentRecordId && ctx.presetRefs.has(d.treatmentRecordId))) return true;
  if (kind !== "collective") return false;
  return depositInYear(d, ctx.receiptsYear) && depositServiceDone(d, ctx.today);
}

/** Anzahlung aus dem Jahr der Sammelrechnung (ohne Jahr bzw. Datum: ja) */
export const depositInYear = (d: Pick<DepositRef, "issuedAt">, year?: number | null): boolean => !year || !d.issuedAt || d.issuedAt.startsWith(String(year));
