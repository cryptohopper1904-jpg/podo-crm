/**
 * Ports (anbieterneutrale Schnittstellen) für alle externen Integrationen – PLAN Kap. 6.
 *
 * Jede Integration implementiert genau einen Port und hat
 *  - einen `mock`-Adapter (deterministisch, offline, für Entwicklung und Tests) und
 *  - einen echten Adapter (ggf. nur als Gerüst, das „nicht konfiguriert“ meldet).
 *
 * Die `provider`-IDs entsprechen `integrationProviderEnum` in src/db/schema.ts.
 * Geldbeträge immer in Cent (integer). Datumswerte als ISO-Strings.
 */
import type { integrationProviderEnum, integrationStatusEnum } from "@/db/schema";

export type ProviderId = (typeof integrationProviderEnum.enumValues)[number];
export type IntegrationStatus = (typeof integrationStatusEnum.enumValues)[number];

/** Verbindungsdaten wie in `integration_connections`, Geheimnis bereits entschlüsselt oder noch verschlüsselt. */
export interface IntegrationConnection {
  provider?: ProviderId;
  status: IntegrationStatus;
  config?: Record<string, unknown>;
  /** Verschlüsselt (src/lib/crypto.ts, Format v1:…) – wird von der Registry entschlüsselt. */
  secretEnc?: string | null;
  /** Bereits entschlüsselte Geheimnisse (z. B. `{ apiKey }`), hat Vorrang vor secretEnc. */
  secret?: Record<string, string> | null;
  /** Optional: Mandanten-ID als AAD für die Entschlüsselung. */
  organizationId?: string;
}

/** Für Adapter, die HTTP sprechen – erlaubt das Einschleusen eines Fake-`fetch` in Tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BasePort<P extends ProviderId = ProviderId> {
  readonly provider: P;
  /** true, wenn es sich um den Mock-Adapter handelt. */
  readonly isMock: boolean;
}

// ───────────────────────── Buchhaltung (lexoffice) ─────────────────────────
export interface AccountingContactInput {
  /** bereits bekannte lexoffice-Kontakt-ID → Update statt Neuanlage */
  externalId?: string | null;
  salutation?: string | null;
  firstName?: string | null;
  lastName: string;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  countryCode?: string;
  email?: string | null;
  phone?: string | null;
  /** interne Kundennummer (Patientennummer) als Notiz */
  customerNumber?: string | number | null;
}

export interface AccountingVoucherLine {
  /** Bruttobetrag der Position in Cent */
  grossCents: number;
  /** 0, 7 oder 19 */
  vatRate: number;
  /** optional abweichende lexoffice-Buchungskategorie */
  categoryId?: string;
}

/**
 * Beleg für eine im CRM erzeugte Rechnung/Quittung. Das CRM ist führend für Rechnungsnummern;
 * lexoffice erhält nur den Buchungsbeleg (Voucher-API), KEINE medizinischen Details.
 */
export interface AccountingVoucherInput {
  invoiceId: string;
  /** Rechnungsnummer aus dem CRM */
  number: string;
  kind: "invoice" | "receipt" | "collective" | "credit_note" | "no_show_fee";
  /** YYYY-MM-DD */
  date: string;
  dueDate?: string | null;
  totalGrossCents: number;
  totalTaxCents: number;
  lines: AccountingVoucherLine[];
  contactExternalId?: string | null;
  /** Freitext ohne Gesundheitsdaten, z. B. „Rechnung 2026-0012“ */
  remark?: string;
  /** optional: PDF der Rechnung als Belegbild */
  pdf?: { filename: string; data: Uint8Array };
}

export type AccountingPaymentStatus = "open" | "partially_paid" | "paid" | "voided" | "unknown";

export interface AccountingPort extends BasePort<"lexoffice"> {
  upsertContact(input: AccountingContactInput): Promise<{ externalId: string; version: number }>;
  pushVoucher(input: AccountingVoucherInput): Promise<{ externalId: string }>;
  getPaymentStatus(externalId: string): Promise<{ status: AccountingPaymentStatus; openCents: number; raw?: unknown }>;
}

// ───────────────────────── Zahlungen (SumUp) ─────────────────────────
export interface CheckoutInput {
  /** eindeutige Referenz, z. B. Rechnungs-ID */
  reference: string;
  amountCents: number;
  currency?: "EUR";
  description?: string;
  returnUrl?: string;
  redirectUrl?: string;
}

export interface CheckoutResult {
  checkoutId: string;
  /** Zahlungslink (Hosted Checkout) – an Patient:in senden */
  url: string | null;
  status: PaymentTxStatus;
}

export interface TerminalPaymentInput {
  readerId: string;
  amountCents: number;
  currency?: "EUR";
  description?: string;
  /** Webhook-URL für das Ergebnis */
  returnUrl?: string;
  reference?: string;
}

export type PaymentTxStatus = "pending" | "paid" | "failed" | "cancelled" | "refunded" | "unknown";

export interface PaymentTransaction {
  id: string;
  status: PaymentTxStatus;
  amountCents: number;
  currency: string;
  reference?: string | null;
  paidAt?: string | null;
  cardType?: string | null;
  raw?: unknown;
}

export interface NormalizedWebhookEvent {
  provider: ProviderId;
  /** für Idempotenz (webhook_events.external_id) */
  externalId: string;
  type: string;
  /** betroffenes Objekt, z. B. Checkout- oder Transaktions-ID */
  objectId?: string | null;
  status?: PaymentTxStatus | AccountingPaymentStatus | null;
  /** true: Status muss per API nachgeladen werden (Payload ist nicht autoritativ) */
  needsFetch: boolean;
  raw: unknown;
}

export interface PaymentPort extends BasePort<"sumup"> {
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  startTerminalPayment(input: TerminalPaymentInput): Promise<{ clientTransactionId: string }>;
  getTransaction(id: string, by?: "id" | "client_transaction_id" | "checkout"): Promise<PaymentTransaction>;
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean;
}

// ───────────────────────── Termine (Doctolib) ─────────────────────────
export type Gender = "female" | "male" | "diverse" | "unknown";

/** Patientenentwurf aus einem Fremdsystem (noch nicht in der DB). */
export interface PatientDraft {
  externalId?: string | null;
  salutation?: string | null;
  title?: string | null;
  gender?: Gender;
  lastName: string;
  maidenName?: string | null;
  firstName?: string | null;
  /** YYYY-MM-DD */
  birthDate?: string | null;
  email?: string | null;
  phoneMobile?: string | null;
  phoneLandline?: string | null;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  insuranceType?: "gkv" | "pkv" | "self" | "beihilfe" | null;
  insuranceSectorRaw?: string | null;
  crucialInfo?: string | null;
  referrer?: string | null;
  occupation?: string | null;
  gpName?: string | null;
  gpCity?: string | null;
  notes?: string | null;
  noNotifications?: boolean;
}

export interface AppointmentCandidate {
  kind: "booked" | "cancelled" | "moved" | "unknown";
  /** ISO mit Zeitzone */
  startsAt: string | null;
  endsAt?: string | null;
  patientName?: string | null;
  patientEmail?: string | null;
  patientPhone?: string | null;
  reason?: string | null;
  externalId?: string | null;
  /** 0..1 – unter 0.7 manuell prüfen */
  confidence: number;
  warnings: string[];
}

export interface CsvImportIssue {
  row: number;
  message: string;
}

export type BookingCsvKind = "patients" | "appointments";
export type BookingCsvResult<K extends BookingCsvKind> = K extends "patients"
  ? { patients: PatientDraft[]; issues: CsvImportIssue[] }
  : { appointments: AppointmentCandidate[]; issues: CsvImportIssue[] };

/**
 * Doctolib: Die Partner-API ist nur für zugelassene Partner zugänglich (Doku passwortgeschützt).
 * Bis zur Freischaltung: CSV-Import/-Export und Parser für Bestätigungsmails (PLAN 6.2 / 14.4).
 */
export interface BookingPort extends BasePort<"doctolib"> {
  importCsv<K extends BookingCsvKind>(kind: K, text: string): Promise<BookingCsvResult<K>>;
  exportPatientsCsv(patients: PatientDraft[]): string;
  parseConfirmationEmail(text: string, subject?: string): AppointmentCandidate;
}

// ───────────────────────── Bewertungen (Google Business Profile) ─────────────────────────
export interface Review {
  externalId: string;
  author: string | null;
  rating: number | null;
  text: string | null;
  reply: string | null;
  createdAt: string | null;
}

export interface ReviewsPort extends BasePort<"google_business"> {
  listReviews(opts?: { pageToken?: string }): Promise<{ reviews: Review[]; nextPageToken?: string | null }>;
  replyToReview(externalId: string, text: string): Promise<void>;
}

// ───────────────────────── Nachrichten (E-Mail, WhatsApp, SMS) ─────────────────────────
export type MessagingProvider = "email_imap" | "whatsapp" | "sms";

export interface OutboundMessage {
  to: string;
  body: string;
  subject?: string;
  /** WhatsApp: freigegebene Vorlage (außerhalb des 24-h-Fensters Pflicht) */
  template?: { name: string; language: string; params?: string[] };
}

export interface InboundMessage {
  channel: "email" | "whatsapp" | "sms";
  externalId: string;
  from: string;
  to?: string | null;
  subject?: string | null;
  body: string;
  receivedAt: string;
  threadKey?: string | null;
}

export interface MessagingPort extends BasePort<MessagingProvider> {
  send(msg: OutboundMessage): Promise<{ externalId: string }>;
  /** Normalisiert eingehende Webhook-Payloads (WhatsApp/SMS) bzw. Rohmails (E-Mail). */
  parseInbound(payload: unknown): InboundMessage[];
}

// ───────────────────────── KI-Telefonagent (Platzhalter, P2) ─────────────────────────
export type VoiceCallEvent =
  | { type: "call_started"; callId: string; from: string | null; at: string }
  | { type: "call_ended"; callId: string; durationSec: number | null; summary?: string | null; at: string }
  | { type: "tool_call"; callId: string; tool: VoiceTool; args: Record<string, unknown>; toolCallId: string }
  | { type: "unknown"; raw: unknown };

export type VoiceTool = "check_availability" | "book_appointment" | "cancel_appointment";

/** Vom CRM bereitgestellte Funktionen, die der Agent über Tool-Endpunkte aufruft. */
export interface VoiceToolHandlers {
  checkAvailability(args: { from: string; to: string; serviceCode?: string }): Promise<{ slots: string[] }>;
  bookAppointment(args: { startsAt: string; name: string; phone?: string; serviceCode?: string }): Promise<{ ok: boolean; reference?: string; message: string }>;
  cancelAppointment(args: { reference?: string; phone?: string; startsAt?: string }): Promise<{ ok: boolean; message: string }>;
}

export interface VoiceAgentPort extends BasePort<"voice_agent"> {
  /** Vendor-Payload (Vapi/Retell/Fonio/sipgate) → normalisiertes Ereignis */
  parseEvent(payload: unknown): VoiceCallEvent;
  /** Führt einen Tool-Aufruf aus und liefert die Antwort im Vendor-Format. */
  handleToolCall(event: Extract<VoiceCallEvent, { type: "tool_call" }>, handlers: VoiceToolHandlers): Promise<unknown>;
}

// ───────────────────────── Transkription ─────────────────────────
export interface TranscriptionPort extends BasePort<"transcription"> {
  transcribe(audio: Uint8Array, opts?: { mime?: string; language?: string; filename?: string }): Promise<{ text: string; durationSec?: number | null }>;
}

// ───────────────────────── LLM ─────────────────────────
export interface StructuredReport {
  findings: string;
  services: string;
  material: string;
  reaction: string;
  recommendation: string;
}

export interface NewsItemInput {
  title: string;
  url: string;
  text?: string;
}

export interface LlmPort extends BasePort<"llm"> {
  /** Sprachbericht-Transkript → strukturierte Doku-Felder (Entwurf; Therapeut:in prüft und bestätigt) */
  structureReport(transcript: string, opts?: { knownNames?: string[] }): Promise<StructuredReport>;
  suggestReply(message: string, context?: { practiceName?: string; tone?: "formal" | "friendly"; knownNames?: string[]; facts?: string[] }): Promise<string>;
  summarizeNews(items: NewsItemInput[]): Promise<{ url: string; summary: string }[]>;
}

/** Zuordnung Provider → Port */
export interface PortByProvider {
  lexoffice: AccountingPort;
  sumup: PaymentPort;
  doctolib: BookingPort;
  google_business: ReviewsPort;
  email_imap: MessagingPort;
  whatsapp: MessagingPort;
  sms: MessagingPort;
  voice_agent: VoiceAgentPort;
  transcription: TranscriptionPort;
  llm: LlmPort;
}

export type SupportedProvider = keyof PortByProvider;
