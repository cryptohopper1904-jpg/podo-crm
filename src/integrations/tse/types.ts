/**
 * Kasse / TSE (KassenSichV, § 146a AO) – anbieterneutraler Port.
 *
 * WICHTIG: Bargeld-Zahlungen in einer elektronischen Kasse brauchen eine zertifizierte
 * Technische Sicherheitseinrichtung (TSE), eine Kassenmeldung an das Finanzamt (§ 146a Abs. 4 AO)
 * und einen DSFinV-K-Export. Der Mock-Adapter erzeugt nur Test-Signaturen – er ersetzt KEINE TSE.
 * Vor dem echten Bargeldeinsatz ist ein Vertrag mit einem zertifizierten Anbieter
 * (z. B. fiskaly SIGN DE, Cloud-TSE) Pflicht.
 */
export type FiscalVatRate = 0 | 7 | 19;

export interface FiscalAmount {
  vatRate: FiscalVatRate;
  /** Brutto in Cent (negativ bei Erstattung) */
  grossCents: number;
}

export interface FiscalStartInput {
  /** eigene Referenz (z. B. Rechnungsnummer) – keine Gesundheitsdaten */
  reference: string;
}

export interface FiscalFinishInput {
  transactionId: string;
  reference: string;
  /** Beträge je Steuersatz */
  amounts: FiscalAmount[];
  /** Zahlart: Bar (Pflicht für TSE) oder unbar */
  paymentType: "cash" | "non_cash";
  /** Summe der Zahlung in Cent */
  paymentCents: number;
}

export interface FiscalSignature {
  transactionId: string;
  /** fortlaufende Transaktionsnummer der TSE */
  number: number;
  /** Signaturzähler */
  signatureCounter: number;
  signature: string;
  startedAt: string;
  finishedAt: string;
  /** Seriennummer der TSE */
  tssSerial: string;
  /** true = Test-/Mock-Signatur (keine gültige TSE!) */
  isTest: boolean;
}

export interface FiscalExportInput {
  /** YYYY-MM-DD */
  from: string;
  /** YYYY-MM-DD */
  to: string;
}

export interface FiscalPort {
  readonly vendor: "mock" | "fiskaly";
  readonly isMock: boolean;
  startTransaction(input: FiscalStartInput): Promise<{ transactionId: string; startedAt: string }>;
  finishTransaction(input: FiscalFinishInput): Promise<FiscalSignature>;
  /** DSFinV-K-Export (Kassendaten für die Betriebsprüfung) – liefert eine Export-ID/Download-Referenz */
  exportDsfinvk(input: FiscalExportInput): Promise<{ exportId: string; status: "pending" | "ready"; downloadUrl?: string | null }>;
  /** Kassenabschluss (Z-Bon) an den TSE-/DSFinV-K-Dienst melden – liefert eine Referenz für den Abschluss */
  registerCashPointClosing?(input: FiscalClosingInput): Promise<{ closingRef: string; tssSerial?: string | null }>;
}

export interface FiscalClosingInput {
  /** eigene ID des Abschlusses (UUID) */
  closingId: string;
  /** Z-Nummer (fortlaufend) */
  number: number;
  /** YYYY-MM-DD */
  businessDate: string;
  /** Summen je Zahlart (DSFinV-K-Typ) in Cent */
  payments: { type: "Bar" | "Unbar"; name: string; amountCents: number }[];
  /** Summen je Geschäftsvorfall und USt-Schlüssel in Cent */
  businessCases: { gvTyp: string; ustKey: number; grossCents: number; netCents: number; vatCents: number }[];
}

export class FiscalNotConfiguredError extends Error {
  constructor(detail?: string) {
    super(`TSE nicht konfiguriert${detail ? `: ${detail}` : "."}`);
    this.name = "FiscalNotConfiguredError";
  }
}

/** Kurzreferenz für payments.external_ref */
export const fiscalRef = (s: FiscalSignature) => `tse:${s.isTest ? "test:" : ""}${s.tssSerial}:${s.number}:${s.signatureCounter}`;

/** Verteilt einen (Teil-)Zahlbetrag anteilig auf die Steuersätze der Rechnung (Rundungsrest auf die größte Gruppe). */
export function allocateByVat(paymentCents: number, groups: { rate: number; grossCents: number }[]): FiscalAmount[] {
  const total = groups.reduce((s, g) => s + g.grossCents, 0);
  const valid = groups.filter((g) => g.grossCents !== 0);
  if (!valid.length || total === 0) return [{ vatRate: 0, grossCents: paymentCents }];
  const out = valid.map((g) => ({ vatRate: (g.rate === 7 || g.rate === 19 ? g.rate : 0) as FiscalVatRate, grossCents: Math.round((paymentCents * g.grossCents) / total) }));
  const diff = paymentCents - out.reduce((s, a) => s + a.grossCents, 0);
  if (diff) {
    const idx = out.reduce((best, a, i) => (Math.abs(a.grossCents) > Math.abs(out[best].grossCents) ? i : best), 0);
    out[idx].grossCents += diff;
  }
  return out;
}
