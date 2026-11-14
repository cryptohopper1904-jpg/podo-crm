/**
 * Beschriftungen für Rechnungen/Zahlungen in Listen, Badges und Buttons – auch im Browser nutzbar.
 * Im Alltag gibt es nur eine Quittung (Q); die Anzahlung (AZ) ist der Sonderfall „Vorauszahlung vor der Behandlung“.
 */
export const INVOICE_KIND_LABEL: Record<string, string> = {
  invoice: "Rechnung",
  receipt: "Quittung",
  collective: "Sammelrechnung",
  no_show_fee: "Ausfallhonorar",
  credit_note: "Stornorechnung",
  deposit: "Anzahlung",
};

/**
 * Bezeichnung auf dem Beleg selbst (PDF-Titel, Begleit-E-Mail, Patientenportal). Bleibt für ausgestellte Belege
 * unverändert (GoBD) – eine Anzahlung wird als Quittung über die Anzahlung ausgestellt.
 */
export const INVOICE_DOC_LABEL: Record<string, string> = { ...INVOICE_KIND_LABEL, deposit: "Quittung (Anzahlung)" };

/** Hinweis bei Quittungen: sie können später in die Sammelrechnung übernommen werden. */
export const RECEIPT_COLLECTIVE_HINT = "Bezahlte Quittungen können später in die Sammelrechnung übernommen werden.";
/** Wofür eine Anzahlung (Vorauszahlung) gedacht ist. */
export const DEPOSIT_PURPOSE_HINT = "Nur für Zahlungen vor der Behandlung, z. B. Nagelspange. Für erbrachte Behandlungen bitte eine Quittung erstellen.";
/** Ablehnung einer Anzahlung für einen vergangenen/heutigen Termin bzw. eine dokumentierte Behandlung */
export const DEPOSIT_PAST_ERROR = "Für erbrachte Behandlungen bitte eine Quittung erstellen.";

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
/** Zahlarten für eine Anzahlung (Vorauszahlung, sofort erhalten – kein Zahlungslink) */
export const DEPOSIT_METHODS = ["cash", "card", "transfer"] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export const NOTE_DEPOSIT = "Anzahlung – dieser Betrag wird auf Ihre Sammelrechnung angerechnet. Bitte bewahren Sie die Quittung auf.";
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export const THERAPEUTIC_LABEL = "Heilbehandlung mit therapeutischem Ziel (Befund/Verordnung dokumentiert)";
export const NOTE_VAT_EXEMPT = "Umsatzsteuerfrei gemäß § 4 Nr. 14 a UStG (Heilbehandlung im Bereich der Humanmedizin).";
/** Zusatz, wenn Produkte in der Behandlung angewendet wurden (unselbständige Nebenleistung, src/lib/product-vat.ts) */
export const NOTE_VAT_EXEMPT_WITH_PRODUCTS =
  "Umsatzsteuerfrei gemäß § 4 Nr. 14 a UStG (Heilbehandlung im Bereich der Humanmedizin) einschließlich der in der Behandlung angewendeten Produkte (Nebenleistung).";
/** Steuerbefreiungs-Hinweis passend zu den Positionen */
export const vatExemptNote = (lines: readonly { inTreatment?: boolean | null }[]) =>
  lines.some((l) => !!l.inTreatment) ? NOTE_VAT_EXEMPT_WITH_PRODUCTS : NOTE_VAT_EXEMPT;
/** Kleinunternehmer-Hinweis für neue Belege (§ 34a UStDV, seit 2025: „Steuerbefreiung für Kleinunternehmer“) */
export const NOTE_SMALL_BUSINESS = "Steuerbefreiung für Kleinunternehmer (§ 19 UStG).";
/**
 * Bisheriger Wortlaut – für Belege ohne Momentaufnahme (ausgestellt vor dem Beleg-Archiv), damit Neudruck und
 * Druckansicht bereits ausgestellter Belege unverändert bleiben. Neue Belege halten ihren Wortlaut in
 * invoices.issued_snapshot.smallBusinessNote fest.
 */
export const NOTE_SMALL_BUSINESS_LEGACY = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).";
export const NOTE_NO_SHOW =
  "Ausfallhonorar gemäß § 615 BGB für einen nicht wahrgenommenen und nicht rechtzeitig abgesagten Termin. Als Schadensersatz nicht umsatzsteuerbar.";
/** Interne Notizzeilen mit diesem Präfix werden nicht gedruckt. */
export const INTERNAL_NOTE_PREFIX = "[intern] ";
