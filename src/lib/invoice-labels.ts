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
  copayment: "Zuzahlungsquittung",
};

/**
 * Bezeichnung auf dem Beleg selbst (PDF-Titel, Begleit-E-Mail, Patientenportal). Bleibt für ausgestellte Belege
 * unverändert (GoBD) – eine Anzahlung wird als Quittung über die Anzahlung ausgestellt.
 */
export const INVOICE_DOC_LABEL: Record<string, string> = { ...INVOICE_KIND_LABEL, deposit: "Quittung (Anzahlung)" };

/**
 * Bezeichnung eines Belegs beim Versand (Betreff/Text der Begleit-E-Mail): Storno einer Zuzahlungsquittung ist keine
 * „Stornorechnung“ (Paket-B-Nachzug) – `cancelsKind` = Belegart des stornierten Belegs.
 */
export function invoiceDocLabel(kind: string, cancelsKind?: string | null): string {
  if (kind === "credit_note") return cancelsKind === "copayment" ? "Storno Zuzahlungsquittung" : "Stornorechnung";
  return INVOICE_DOC_LABEL[kind] ?? "Rechnung";
}

/**
 * Bemerkung zum Beleg in der Buchhaltung (lexoffice): bisheriger Wortlaut, nur das Storno einer Zuzahlungsquittung heißt
 * „Storno Zuzahlungsquittung …“ statt „Stornorechnung …“. `cancelsKind` = Belegart des stornierten Belegs.
 */
export function accountingRemark(kind: string, number: string, cancelsKind?: string | null, withReceipts = false): string {
  const label = kind === "credit_note" ? invoiceDocLabel(kind, cancelsKind) : kind === "copayment" ? "Zuzahlungsquittung" : "Rechnung";
  return `${label} ${number}${withReceipts ? " (abzgl. angerechneter Quittungen)" : ""}`;
}

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

/**
 * Belegarten, die KEINE Abrechnung von Leistungen sind – für die Heuristik „eigener Beleg der Person am Behandlungstag
 * = abgerechnet“ (Sammelrechnungs-Vorschlag, Jahresend-Erinnerung): Storno, Sammelrechnung (exakt über Positionen),
 * Anzahlung und Zuzahlungsquittung (GKV-Zuzahlung, keine Privatleistung – Review Paket B R2-1).
 */
export const NOT_BILLING_KINDS = ["credit_note", "collective", "deposit", "copayment"] as const;

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

/** Altbestand aus dem Import (invoices.source ≠ "crm"): nur Nachschlagen – Buchhaltung L1/P1 */
export const IMPORTED_INVOICE_LOCKED =
  "Übernommene Altrechnung (Import) – sie wurde in Ihrer bisherigen Software ausgestellt. Versand, Zahlungslink und Kartenzahlung sind hier nicht möglich.";
export const IMPORTED_LEXOFFICE_NOTE = "Altbestand aus Import – nicht an lexoffice übertragbar";
/** Zahlung erfassen auf einer übernommenen Altrechnung (Buchhaltung BA) */
export const IMPORTED_PAYMENT_NOTE =
  "Zahlungseingang auf eine übernommene Altrechnung: erscheint in der PodoHero-Kasse; in der Buchhaltung manuell gegen die alte Forderung ausbuchen.";
/** Storno einer übernommenen Altrechnung (Buchhaltung BD) */
export const IMPORTED_CANCEL_NOTE = "Storno einer übernommenen Altrechnung – in der Buchhaltung manuell gegen den Originalbeleg buchen.";
/** Auswertung: Datum übernommener Zahlungen (Buchhaltung BF) */
export const IMPORTED_PAYMENTS_DATED_NOTE = "Übernommene Zahlungen sind auf das Rechnungsdatum datiert.";
/** Sammelrechnung: übernommene Quittung (Buchhaltung BC) */
export const IMPORTED_RECEIPT_MARK = "Altbestand";
/** Rechnung/Quittung zu einem übernommenen Termin (Quelle „import“) – gesperrt (Code-Review Runde 2 S1, Runde 3 CS2) */
export const IMPORTED_APPOINTMENT_NOT_BILLABLE =
  "Übernommener Termin (Import) – er wurde in Ihrer bisherigen Software abgerechnet. Eine Rechnung oder Quittung dazu ist hier nicht möglich.";
