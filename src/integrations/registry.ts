/**
 * Adapter-Registry: liefert für einen Provider den passenden Adapter.
 *
 * Mock wird verwendet, wenn
 *  - env `INTEGRATIONS_MODE=mock` gesetzt ist (Entwicklung, Tests, Demo) oder
 *  - die Verbindung den Status „mock“ hat (pro Mandant umschaltbar).
 * Sonst wird der echte Adapter mit Config + entschlüsseltem Geheimnis gebaut; fehlen Zugangsdaten,
 * wirft der Konstruktor `IntegrationNotConfiguredError`.
 *
 * Konventionen für `integration_connections`:
 *  - `secret_enc` = encryptSecret(JSON.stringify({ apiKey | accessToken, webhookSecret?, password? }), organizationId)
 *  - `config`     = nicht geheime Einstellungen (baseUrl, merchantCode, phoneNumberId, …)
 */
import { decryptJson } from "@/lib/crypto";
import { IntegrationNotConfiguredError } from "./errors";
import { assertSafeHostSyntax, assertSafeUrlSyntax, guardedFetch } from "./net-guard";
import { DoctolibAdapter, DoctolibMock } from "./doctolib/doctolib";
import { GoogleBusinessAdapter, GoogleBusinessMock } from "./google/google-business";
import { LexofficeAdapter } from "./lexoffice/lexoffice";
import { LexofficeMock } from "./lexoffice/mock";
import { LlmMock } from "./llm/mock";
import { OpenAiCompatibleLlm } from "./llm/openai-compatible";
import { EmailAdapter, MessagingMock, SmsAdapter, WhatsAppAdapter } from "./messaging/messaging";
import { SumupMock } from "./sumup/mock";
import { SumupAdapter } from "./sumup/sumup";
import { TranscriptionMock, WhisperCompatibleTranscription } from "./transcription/transcription";
import type { FetchLike, IntegrationConnection, PortByProvider, SupportedProvider } from "./types";
import { VoiceAgentAdapter, VoiceAgentMock } from "./voice/voice-agent";

export interface RegistryOptions {
  /** überschreibt process.env.INTEGRATIONS_MODE */
  mode?: "mock" | "live";
  fetch?: FetchLike;
}

let warnedProdMock = false;

export function isMockMode(connection?: Pick<IntegrationConnection, "status"> | null, opts: RegistryOptions = {}): boolean {
  const mode = opts.mode ?? process.env.INTEGRATIONS_MODE;
  if (mode === "mock" && process.env.NODE_ENV === "production" && !warnedProdMock) {
    // In der Testphase einer Praxis erlaubt – aber sichtbar protokollieren
    warnedProdMock = true;
    console.warn("[integrations] INTEGRATIONS_MODE=mock in Produktion: Es werden keine echten Zahlungen/Nachrichten verarbeitet.");
  }
  return mode === "mock" || connection?.status === "mock";
}

/** Frei konfigurierbare Ziele (baseUrl, Hosts) formal prüfen – DNS-Prüfung erfolgt in guardedFetch vor jedem Request. */
function checkTargets(cfg: Record<string, unknown>) {
  if (typeof cfg.baseUrl === "string" && cfg.baseUrl) assertSafeUrlSyntax(cfg.baseUrl);
  for (const k of ["smtpHost", "imapHost"]) if (typeof cfg[k] === "string" && cfg[k]) assertSafeHostSyntax(cfg[k] as string);
}

function resolveSecret(connection: IntegrationConnection | null | undefined): Record<string, string> {
  if (!connection) return {};
  if (connection.secret) return connection.secret;
  // AAD = Mandanten-ID (src/lib/secrets.ts encryptSecret(…, organizationId))
  if (connection.secretEnc) return decryptJson<Record<string, string>>(connection.secretEnc, { aad: connection.organizationId });
  return {};
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const MOCKS: { [P in SupportedProvider]: () => PortByProvider[P] } = {
  lexoffice: () => new LexofficeMock(),
  sumup: () => new SumupMock(),
  doctolib: () => new DoctolibMock(),
  google_business: () => new GoogleBusinessMock(),
  email_imap: () => new MessagingMock("email_imap"),
  whatsapp: () => new MessagingMock("whatsapp"),
  sms: () => new MessagingMock("sms"),
  voice_agent: () => new VoiceAgentMock(),
  transcription: () => new TranscriptionMock(),
  llm: () => new LlmMock(),
};

type Builder<P extends SupportedProvider> = (cfg: Record<string, unknown>, sec: Record<string, string>, f?: FetchLike) => PortByProvider[P];

const REAL: { [P in SupportedProvider]: Builder<P> } = {
  lexoffice: (cfg, sec, f) =>
    new LexofficeAdapter({
      apiKey: sec.apiKey,
      baseUrl: str(cfg.baseUrl),
      categoryIdTaxFree: str(cfg.categoryIdTaxFree),
      categoryIdTaxable: str(cfg.categoryIdTaxable),
      fetch: f,
    }),
  sumup: (cfg, sec, f) =>
    new SumupAdapter({
      accessToken: sec.accessToken ?? sec.apiKey,
      merchantCode: str(cfg.merchantCode),
      webhookSecret: sec.webhookSecret,
      signatureHeader: str(cfg.signatureHeader),
      baseUrl: str(cfg.baseUrl),
      fetch: f,
    }),
  doctolib: () => new DoctolibAdapter(),
  google_business: (cfg, sec) =>
    new GoogleBusinessAdapter({ accessToken: sec.accessToken, accountId: str(cfg.accountId), locationId: str(cfg.locationId) }),
  email_imap: (cfg, sec) => new EmailAdapter({ smtpHost: str(cfg.smtpHost), imapHost: str(cfg.imapHost), user: str(cfg.user), password: sec.password }),
  whatsapp: (cfg, sec, f) =>
    new WhatsAppAdapter({ accessToken: sec.accessToken, phoneNumberId: str(cfg.phoneNumberId), baseUrl: str(cfg.baseUrl), fetch: f }),
  sms: (cfg, sec, f) =>
    new SmsAdapter({ apiKey: sec.apiKey, sender: str(cfg.sender), vendor: cfg.vendor === "sipgate" ? "sipgate" : "seven", fetch: f }),
  voice_agent: (cfg, sec) =>
    new VoiceAgentAdapter({ vendor: str(cfg.vendor) as "vapi" | "retell" | "fonio" | "sipgate" | undefined, apiKey: sec.apiKey }),
  transcription: (cfg, sec, f) =>
    new WhisperCompatibleTranscription({
      baseUrl: str(cfg.baseUrl),
      apiKey: sec.apiKey,
      model: str(cfg.model),
      dataProcessingApproved: cfg.dataProcessingApproved === true,
      fetch: f,
    }),
  llm: (cfg, sec, f) =>
    new OpenAiCompatibleLlm({
      baseUrl: str(cfg.baseUrl),
      apiKey: sec.apiKey,
      model: str(cfg.model),
      dataProcessingApproved: cfg.dataProcessingApproved === true,
      fetch: f,
    }),
};

export function getAdapter<P extends SupportedProvider>(
  provider: P,
  connection?: IntegrationConnection | null,
  opts: RegistryOptions = {},
): PortByProvider[P] {
  if (!(provider in MOCKS)) throw new IntegrationNotConfiguredError(provider, "kein Adapter vorhanden");
  if (isMockMode(connection, opts)) return MOCKS[provider]();
  if (connection?.status === "disconnected" && provider !== "doctolib" && provider !== "llm" && provider !== "transcription") {
    // LLM/Transkription dürfen über env konfiguriert sein, Doctolib arbeitet lokal
    throw new IntegrationNotConfiguredError(provider, "Verbindung ist getrennt");
  }
  const cfg = connection?.config ?? {};
  checkTargets(cfg);
  // Jeder echte Request läuft über den SSRF-Schutz (https, keine privaten Ziele, keine Weiterleitungen)
  return REAL[provider](cfg, resolveSecret(connection), guardedFetch(opts.fetch));
}
