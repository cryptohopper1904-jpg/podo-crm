/** Beschriftungen für Rechnungen/Zahlungen – auch im Browser nutzbar. */
export const INVOICE_KIND_LABEL: Record<string, string> = {
  invoice: "Rechnung",
  receipt: "Quittung",
  collective: "Sammelrechnung",
  no_show_fee: "Ausfallhonorar",
  credit_note: "Stornorechnung",
  deposit: "Quittung (Anzahlung)",
};

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: "Entwurf",
  issued: "offen",
  partially_paid: "teilbezahlt",
  paid: "bezahlt",
  cancelled: "storniert",
};

export const INVOICE_STATUS_TONE: Record<string, "primary" | "accent" | "info" | "warn" | "neutral"> = {
  draft: "neutral",
  issued: "warn",
  partially_paid: "info",
  paid: "primary",
  cancelled: "neutral",
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Bar",
  card: "Karte (SumUp)",
  transfer: "Überweisung",
  voucher: "Gutschein",
  payment_link: "Zahlungslink",
};

export const PAYMENT_METHODS = ["cash", "card", "transfer", "voucher", "payment_link"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CREATABLE_KINDS = ["invoice", "receipt", "collective", "no_show_fee"] as const;
/** Zahlarten für eine Anzahlungs-Quittung (sofort erhalten – kein Zahlungslink) */
export const DEPOSIT_METHODS = ["cash", "card", "transfer"] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export const NOTE_DEPOSIT = "Anzahlung – dieser Betrag wird auf Ihre Sammelrechnung angerechnet. Bitte bewahren Sie die Quittung auf.";
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export const THERAPEUTIC_LABEL = "Heilbehandlung mit therapeutischem Ziel (Befund/Verordnung dokumentiert)";
export const NOTE_VAT_EXEMPT = "Umsatzsteuerfrei gemäß § 4 Nr. 14 a UStG (Heilbehandlung im Bereich der Humanmedizin).";
export const NOTE_SMALL_BUSINESS = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).";
export const NOTE_NO_SHOW =
  "Ausfallhonorar gemäß § 615 BGB für einen nicht wahrgenommenen und nicht rechtzeitig abgesagten Termin. Als Schadensersatz nicht umsatzsteuerbar.";
/** Interne Notizzeilen mit diesem Präfix werden nicht gedruckt. */
export const INTERNAL_NOTE_PREFIX = "[intern] ";
