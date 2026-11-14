/**
 * TSE-Angaben auf Belegen (§ 146a Abs. 2 AO, § 6 KassenSichV, AEAO zu § 146a Nr. 6.4/6.5): Zeitpunkt von
 * Vorgangsbeginn und -ende, Transaktionsnummer, Seriennummer der TSE, Signaturzähler und Prüfwert (Signatur).
 * Reine Funktionen – gleich für PDF (Rechnung/Quittung, Zahlungsbeleg) und Druckansicht.
 * Mock-Signaturen (Testmodus, keine zertifizierte TSE) werden deutlich als Testmodus gekennzeichnet.
 */

export type FiscalInfo = {
  vendor: string;
  tssSerial: string;
  txNumber: number;
  signatureCounter: number;
  signature: string;
  startedAt: Date | string;
  finishedAt: Date | string;
  processType: string;
  isTest: boolean;
};

export const TSE_TEST_NOTICE = "TESTMODUS: Test-Signatur ohne zertifizierte TSE – kein gültiger Kassenbeleg nach KassenSichV.";
/** Ausfall der TSE: Pflichtvermerk auf dem Beleg (AEAO zu § 146a Nr. 6.5, „Sicherheitseinrichtung ausgefallen“) */
export const TSE_FAILED_NOTICE = "Sicherheitseinrichtung ausgefallen – Vorgang ohne TSE-Signatur aufgezeichnet.";

const SECONDS = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** TT.MM.JJJJ, hh:mm:ss (Europe/Berlin) */
export const dateTimeSecondsDe = (d: Date | string) => SECONDS.format(new Date(d));

/** Beschriftete Zeilen der TSE-Angaben (Reihenfolge wie auf dem Beleg). */
export function tseLines(f: FiscalInfo): [string, string][] {
  return [
    ["TSE-Seriennummer", f.tssSerial],
    ["TSE-Transaktionsnummer", String(f.txNumber)],
    ["TSE-Signaturzähler", String(f.signatureCounter)],
    ["TSE-Vorgangsbeginn", dateTimeSecondsDe(f.startedAt)],
    ["TSE-Vorgangsende", dateTimeSecondsDe(f.finishedAt)],
    ["TSE-Prozesstyp", f.processType],
    ["TSE-Signatur", f.signature],
  ];
}
