/**
 * Normalisierte Entwürfe aus dem Excel-„Podologie Rechnungsmanager V0.9.2“.
 * Reine Datenstrukturen ohne DB-Bezug. Beträge in Cent, Datum als YYYY-MM-DD.
 */

export type SheetName = "Patienten" | "Leistungen" | "Gutscheine" | "Rechnungen" | "Kalkulation";
export const SHEET_NAMES: SheetName[] = ["Patienten", "Leistungen", "Gutscheine", "Rechnungen", "Kalkulation"];

export type Channel = "email" | "whatsapp" | "sms" | "phone" | "letter" | "none";
export type PaymentMethod = "cash" | "card" | "transfer" | "voucher";
export type InvoiceKind = "invoice" | "receipt" | "collective";
export type ImportedInvoiceStatus = "issued" | "partially_paid" | "paid";

export interface PatientImportDraft {
  /** Zeilennummer im Blatt (1-basiert) */
  row: number;
  legacyId: number | null;
  salutation: "Herr" | "Frau" | "Divers" | null;
  title: string | null;
  lastName: string;
  firstName: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  /** Hausbesuchs-Route aus Excel (kein eigenes DB-Feld, siehe docs/SCHEMA_REQUESTS.md) */
  route: string | null;
  birthDate: string | null;
  phoneMobile: string | null;
  phoneLandline: string | null;
  email: string | null;
  preferredChannel: Channel;
  notes: string | null;
  /** Kennzahlen aus Excel – nur zur Kontrolle, werden im CRM neu berechnet */
  legacy: {
    openAmountCents: number | null;
    revenueCents: number | null;
    treatments: number | null;
    lastTreatment: string | null;
    status: string | null;
  };
}

export interface ServiceImportDraft {
  row: number;
  legacyId: number | null;
  code: string;
  name: string;
  priceCents: number;
  vatRate: number;
  durationMin: number;
}

export interface VoucherImportDraft {
  row: number;
  legacyId: number | null;
  code: string;
  issuedAt: string;
  validUntil: string;
  amountCents: number;
  remainingCents: number | null;
  note: string | null;
}

export interface InvoiceLineDraft {
  position: number;
  serviceCode: string;
  description: string;
  quantity: number;
  factor: number;
  unitPriceCents: number;
  vatRate: number;
  totalCents: number;
}

export interface PaymentDraft {
  method: PaymentMethod;
  amountCents: number;
  /** nur bei method = voucher */
  voucherLegacyId?: number | null;
}

export interface InvoiceImportDraft {
  row: number;
  legacyId: number | null;
  number: string;
  issuedAt: string | null;
  kind: InvoiceKind;
  typeRaw: string | null;
  patientLegacyId: number | null;
  lastName: string | null;
  firstName: string | null;
  paymentRaw: string | null;
  status: ImportedInvoiceStatus;
  voucherLegacyId: number | null;
  payments: PaymentDraft[];
  totalCents: number;
  netCents: number;
  vatCents: number;
  lines: InvoiceLineDraft[];
  statusReceipt: string | null;
  statusCollective: string | null;
  /** bei Sammelrechnungen: Legacy-IDs der zusammengefassten Einzelzeilen */
  collectedLegacyIds: number[];
  /** bei Sammelrechnungen: Rechnungsnummern der zusammengefassten Einzelzeilen (für Nummernkreise) */
  collectedNumbers: string[];
}

export interface FixedCostImportDraft {
  row: number;
  category: string;
  amountCents: number;
  interval: "monthly" | "quarterly" | "yearly";
  monthlyShareCents: number;
  startDate: string;
}

export interface ImportWarning {
  sheet: SheetName | "Arbeitsmappe";
  row: number | null;
  message: string;
}

export interface DuplicateGroup {
  sheet: "Patienten";
  reason: "name_birthdate" | "email" | "phone";
  value: string;
  rows: number[];
  legacyIds: (number | null)[];
}

export interface SheetCount {
  /** Datenzeilen (ohne Kopf) */
  rows: number;
  imported: number;
  skippedEmpty: number;
  skippedInvalid: number;
}

export interface ImportReport {
  counts: Record<SheetName, SheetCount>;
  warnings: ImportWarning[];
  duplicates: DuplicateGroup[];
  /** Summe aller übersprungenen Leerzeilen */
  skippedEmptyRows: number;
  /** in Sammelrechnungen aufgegangene Einzelzeilen */
  collectiveParts: number;
}

export interface ImportResult {
  patients: PatientImportDraft[];
  services: ServiceImportDraft[];
  vouchers: VoucherImportDraft[];
  invoices: InvoiceImportDraft[];
  fixedCosts: FixedCostImportDraft[];
  report: ImportReport;
}
