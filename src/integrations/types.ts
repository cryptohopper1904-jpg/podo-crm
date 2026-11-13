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
  /** interne Patientennummer als Notiz */
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
  kind: "invoice" | "receipt" | "collective" | "credit_note" | "no_show_fee" | "deposit";
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
  /** Offenen Online-Checkout (Zahlungslink) deaktivieren, z. B. nach Storno der Rechnung. */
  deactivateCheckout?(checkoutId: string): Promise<void>;
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
  /** nur E-Mail: Anhänge (z. B. Rechnungs-PDF). SMS/WhatsApp lehnen Anhänge ab. */
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
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

// ───────────────────────── KI-Telefonagent (Pilot, PLAN 4.6) ─────────────────────────
/** Unterstützte Telefonagent-Anbieter (Pfad /api/voice/{vendor}). Umgesetzt: vapi, retell. */
export type VoiceVendorId = "vapi" | "retell" | "fonio" | "sipgate";

/** Werkzeuge, die der Agent über unseren Server aufrufen darf (Namen wie im Assistenten-Prompt). */
export type VoiceTool = "freie_termine" | "termin_buchen" | "termin_absagen" | "rueckruf" | "praxis_info";

export interface VoiceToolCall {
  toolCallId: string;
  /** Name wie vom Anbieter geliefert – unbekannte Namen werden abgelehnt */
  tool: string;
  args: Record<string, unknown>;
}

export interface VoiceToolResult {
  toolCallId: string;
  /** Kurzer deutscher Text, den der Agent vorlesen/verwenden kann – nie Patientendaten */
  result: string;
}

export type VoiceCallEvent =
  | { type: "status"; callId: string; from: string | null; status: string }
  | { type: "tool_calls"; callId: string; from: string | null; calls: VoiceToolCall[] }
  | {
      type: "call_ended";
      callId: string;
      from: string | null;
      startedAt: string | null;
      endedAt: string | null;
      durationSec: number | null;
      endedReason: string | null;
      summary: string | null;
      transcript: string | null;
    }
  | { type: "unknown"; raw: unknown };

export interface VoiceAgentPort extends BasePort<"voice_agent"> {
  readonly vendor: VoiceVendorId;
  /**
   * Prüft die Echtheit eines Aufrufs (fail closed: ohne hinterlegtes Geheimnis immer false).
   * `secret` = entschlüsseltes Geheimnis der Verbindung (integration_connections.secret_enc).
   * `rawBody` = unveränderter Request-Body (für HMAC-Signaturen, z. B. Retell).
   */
  verify(headers: Record<string, string | undefined>, secret: Record<string, string>, rawBody?: string): boolean;
  /** Vendor-Payload → normalisiertes Ereignis */
  parseEvent(payload: unknown): VoiceCallEvent;
  /** Werkzeug-Ergebnisse → Antwort im Vendor-Format */
  formatToolResults(results: VoiceToolResult[]): unknown;
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

// ───────────────────────── KIM (Kommunikation im Medizinwesen, TI) ─────────────────────────
/**
 * KIM-Postfach über das KIM-Clientmodul des KIM-Anbieters (bzw. einen TI-Gateway-Dienst).
 * Das Clientmodul übernimmt S/MIME-Ver-/Entschlüsselung, Signatur und Verzeichnisdienst (VZD);
 * wir sprechen nur die Standard-Schnittstellen SMTP (Versand) und POP3 (Abruf) über TLS.
 * Voraussetzungen der Praxis: SMC-B (Praxisausweis), Konnektor/TI-Gateway, KIM-Vertrag.
 */
export interface KimAttachmentInfo {
  filename: string;
  contentType: string;
  /** Größe der dekodierten Daten in Byte */
  size: number;
}

export interface KimInboundMessage {
  /** Message-ID-Header (ohne spitze Klammern) – Dedupe-Schlüssel */
  messageId: string;
  from: string;
  to: string | null;
  subject: string | null;
  /** ISO-Zeitpunkt (Date-Header, sonst Abrufzeit) */
  receivedAt: string;
  /** text/plain-Inhalt (bei reinem HTML: Text ohne Tags) */
  text: string;
  attachments: KimAttachmentInfo[];
  inReplyTo: string | null;
  /** X-KIM-Dienstkennung, z. B. „eArztbrief;Brief;V1.2“ */
  kimService: string | null;
}

export interface KimSendAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface KimPort {
  readonly provider: "kim";
  readonly isMock: boolean;
  /** Ruft neue Nachrichten ab (Löschen auf dem Server nur, wenn in der Verbindung ausdrücklich aktiviert). */
  fetchInbox(opts?: { limit?: number }): Promise<KimInboundMessage[]>;
  send(to: string, subject: string, body: string, attachments?: KimSendAttachment[], opts?: { inReplyTo?: string | null }): Promise<{ messageId: string }>;
  /** Anmeldung an POP3 (und SMTP) prüfen, ohne Nachrichten zu lesen. */
  ping(): Promise<{ messages: number }>;
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

// ───────────────────────── Verordnungs-OCR ─────────────────────────
// Port + Adapter in src/integrations/ocr; Konfiguration je Praxis in organizations.settings.ocr
// (nicht in integration_connections – der Provider-Enum der DB kennt „ocr“ nicht).
export type { OcrImage, OcrPort } from "./ocr/ocr";
