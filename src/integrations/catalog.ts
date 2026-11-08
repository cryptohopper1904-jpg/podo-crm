/** Anzeige-Metadaten der Schnittstellen für die Einstellungen (Felder, Hinweise, Datenschutz). */
import type { SupportedProvider } from "./types";

export interface ProviderField {
  name: string;
  label: string;
  placeholder?: string;
}

export interface ProviderInfo {
  provider: SupportedProvider;
  label: string;
  description: string;
  privacy: string;
  docs?: string;
  secretFields: ProviderField[];
  configFields: ProviderField[];
}

export const PROVIDER_CATALOG: ProviderInfo[] = [
  {
    provider: "lexoffice",
    label: "lexoffice / Lexware Office",
    description:
      "Buchhaltung: Kontakte und Belege (Voucher-API). Rechnungsnummern, Mischzahlungen und Gutscheine bleiben im CRM führend – lexoffice erhält nur Buchungsbelege.",
    privacy: "AVV mit Lexware nötig. Übertragen werden nur Name, Anschrift und Beträge – keine Diagnosen oder Befunde.",
    docs: "https://developers.lexoffice.io/docs/",
    secretFields: [{ name: "apiKey", label: "API-Schlüssel" }],
    configFields: [],
  },
  {
    provider: "sumup",
    label: "SumUp",
    description: "Kartenzahlung am Solo-Terminal (Cloud API), Zahlungslinks und Transaktionsabgleich per Webhook.",
    privacy: "AVV/Zahlungsdienstvertrag mit SumUp. Als Beschreibung nur Rechnungsnummer, keine Leistungsdetails.",
    docs: "https://developer.sumup.com/api",
    secretFields: [
      { name: "apiKey", label: "API-Schlüssel oder Access-Token" },
      { name: "webhookSecret", label: "Webhook-Geheimnis" },
    ],
    configFields: [
      { name: "merchantCode", label: "Händlercode (merchant_code)", placeholder: "MXXXXXXX" },
      { name: "readerId", label: "Reader-ID (Solo)", placeholder: "rdr_…" },
    ],
  },
  {
    provider: "doctolib",
    label: "Doctolib",
    description:
      "Die Partner-API ist nur für zugelassene Partner verfügbar. Bis dahin: CSV-Import/-Export (Einstellungen → Import) und Auswertung von Bestätigungsmails.",
    privacy: "AVV mit Doctolib prüfen. Automatische Auswertung von Mails nur, wenn der Vertrag sie erlaubt.",
    secretFields: [],
    configFields: [],
  },
  {
    provider: "google_business",
    label: "Google Unternehmensprofil",
    description: "Bewertungen lesen und beantworten. Der API-Zugang muss bei Google beantragt werden (OAuth).",
    privacy:
      "Antworten sind öffentlich: niemals bestätigen, dass jemand Patient:in ist, keine Behandlungs- oder Gesundheitsangaben (Schweigepflicht, § 203 StGB).",
    docs: "https://developers.google.com/my-business",
    secretFields: [{ name: "accessToken", label: "OAuth-Access-Token" }],
    configFields: [
      { name: "accountId", label: "Konto-ID" },
      { name: "locationId", label: "Standort-ID" },
      { name: "placeId", label: "Place-ID (für den Bewertungslink)" },
    ],
  },
  {
    provider: "email_imap",
    label: "E-Mail (SMTP/IMAP)",
    description: "Posteingang und Versand über das Praxispostfach.",
    privacy: "Postfach bei einem Anbieter mit AVV und Serverstandort EU. Gesundheitsdaten nur verschlüsselt (TLS) übertragen.",
    secretFields: [{ name: "password", label: "Passwort / App-Passwort" }],
    configFields: [
      { name: "smtpHost", label: "SMTP-Server" },
      { name: "imapHost", label: "IMAP-Server" },
      { name: "user", label: "Benutzername" },
    ],
  },
  {
    provider: "whatsapp",
    label: "WhatsApp Business (Cloud API)",
    description: "Terminerinnerungen und Rückfragen über einen Business Solution Provider (z. B. 360dialog).",
    privacy:
      "Nur organisatorische Inhalte (Termine) – keine medizinischen Inhalte. Ausdrückliche Einwilligung „WhatsApp“ mit Risikohinweis (Meta) nötig, AVV mit dem BSP.",
    docs: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    secretFields: [
      { name: "accessToken", label: "Access-Token" },
      { name: "appSecret", label: "App-Secret (Webhook-Signatur)" },
    ],
    configFields: [
      { name: "phoneNumberId", label: "Phone-Number-ID" },
      { name: "verifyToken", label: "Webhook-Verify-Token" },
    ],
  },
  {
    provider: "sms",
    label: "SMS (seven.io)",
    description: "Terminerinnerungen per SMS über einen deutschen Anbieter.",
    privacy: "AVV mit dem SMS-Anbieter. Nur Termin und Praxisname, keine Behandlungsdetails.",
    docs: "https://docs.seven.io/",
    secretFields: [{ name: "apiKey", label: "API-Schlüssel" }],
    configFields: [{ name: "sender", label: "Absendername", placeholder: "Podologie" }],
  },
  {
    provider: "voice_agent",
    label: "KI-Telefonagent",
    description: "Pilot: Anrufe annehmen, freie Termine nennen, Terminwünsche, Absagewünsche und Rückrufbitten in den Posteingang (umgesetzt: Vapi; Retell, Fonio, sipgate folgen). Einrichtung unter „Telefon“.",
    privacy: "KI-Hinweis zu Gesprächsbeginn (AI Act Art. 50), Transkript nur mit Ansage und Einstellung, EU-Verarbeitung und AVV.",
    secretFields: [{ name: "vapiSecret", label: "Server-URL-Secret (optional – sonst gilt das Webhook-Token)" }],
    configFields: [{ name: "vendor", label: "Anbieter (Pilot: vapi)", placeholder: "vapi" }],
  },
  {
    provider: "transcription",
    label: "Transkription (Sprachbericht)",
    description: "Wandelt diktierte Behandlungsberichte in Text um (Whisper-kompatibler Endpunkt).",
    privacy: "Audio enthält Gesundheitsdaten: nur EU-Anbieter mit AVV und Zero Data Retention, kein Training auf Kundendaten.",
    secretFields: [{ name: "apiKey", label: "API-Schlüssel" }],
    configFields: [
      { name: "baseUrl", label: "Basis-URL", placeholder: "https://…/v1" },
      { name: "model", label: "Modell", placeholder: "whisper-1" },
    ],
  },
  {
    provider: "llm",
    label: "KI-Sprachmodell",
    description: "Strukturiert Sprachberichte, schlägt Antworten vor und fasst News zusammen (OpenAI-kompatibler Endpunkt).",
    privacy:
      "Nur EU-Anbieter mit AVV und Zero Data Retention (z. B. Azure OpenAI EU, Mistral, Claude über AWS Bedrock Frankfurt). Namen, Telefonnummern, E-Mails und Datumsangaben werden vor dem Versand entfernt.",
    secretFields: [{ name: "apiKey", label: "API-Schlüssel" }],
    configFields: [
      { name: "baseUrl", label: "Basis-URL", placeholder: "https://…/v1" },
      { name: "model", label: "Modell" },
    ],
  },
];

/** Anbieter ohne (umgesetzte) Signatur: Webhook nur mit zufälligem Token `?token=` */
export const TOKEN_WEBHOOK_PROVIDERS: SupportedProvider[] = ["lexoffice", "sms", "voice_agent"];
/** Anbieter mit HMAC-Signatur: Geheimnis ist Pflicht */
export const HMAC_WEBHOOK_SECRET: Partial<Record<SupportedProvider, string>> = { sumup: "webhookSecret", whatsapp: "appSecret" };

export const STATUS_LABEL: Record<string, string> = {
  mock: "Testmodus",
  connected: "verbunden",
  error: "Fehler",
  disconnected: "aus",
};
