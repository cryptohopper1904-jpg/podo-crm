/**
 * Einstellungen der Verordnungs-OCR je Praxis (organizations.settings.ocr) + Adapterwahl.
 * Kein eigener Eintrag in integration_connections (der Provider-Enum der DB kennt „ocr“ nicht) –
 * die Konfiguration ist bewusst an die ausdrückliche Freigabe der Inhaber:in gekoppelt.
 */
import { z } from "zod";
import { decryptJson } from "@/lib/crypto";
import { assertSafeUrlSyntax, guardedFetch } from "../net-guard";
import type { FetchLike } from "../types";
import { OCR_DEFAULT_PROVIDER, OcrMock, OcrNotConfiguredError, OpenAiVisionOcr, type OcrPort } from "./ocr";

/** Version des Bestätigungstexts – bei inhaltlicher Änderung erhöhen (erneute Bestätigung nötig) */
export const OCR_CONSENT_VERSION = "ocr-dpa-v1";

const consentSchema = z.object({
  at: z.string(),
  by: z.string(),
  version: z.string(),
  avv: z.literal(true),
  subprocessor: z.literal(true),
  dataLeavesPractice: z.literal(true),
});

const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["mock", "live"]).default("mock"),
  baseUrl: z.string().max(300).optional(),
  model: z.string().max(120).optional(),
  imageStyle: z.enum(["openai", "string"]).default(OCR_DEFAULT_PROVIDER.imageStyle),
  /** encryptJson({ apiKey }, { aad: organizationId }) */
  apiKeyEnc: z.string().max(2000).optional(),
  consent: consentSchema.optional(),
  /** Höchstzahl Auslesungen je Stunde und Praxis */
  perHour: z.number().int().min(1).max(500).default(60),
});

export type OcrSettings = z.infer<typeof settingsSchema>;
export type OcrConsent = z.infer<typeof consentSchema>;

export const DEFAULT_OCR_SETTINGS: OcrSettings = settingsSchema.parse({});

/** Robust lesen: kaputte/fehlende Einstellungen = Funktion aus. */
export function parseOcrSettings(raw: unknown): OcrSettings {
  const r = settingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_OCR_SETTINGS;
}

export function consentValid(s: OcrSettings): boolean {
  return !!s.consent && s.consent.version === OCR_CONSENT_VERSION;
}

/** Warum die Funktion (noch) nicht nutzbar ist – null = bereit */
export function ocrBlocker(s: OcrSettings, env: { mode?: string } = { mode: process.env.INTEGRATIONS_MODE }): string | null {
  if (!s.enabled) return "Verordnungs-OCR ist ausgeschaltet (Einstellungen → Verordnungs-OCR, nur Inhaber:in).";
  if (env.mode === "mock" || s.mode === "mock") return null;
  if (!consentValid(s)) return "Die Datenschutz-Bestätigung der Inhaber:in fehlt oder ist veraltet.";
  if (!s.baseUrl || !s.model || !s.apiKeyEnc) return "Adresse, Modell oder API-Schlüssel des Auslesedienstes fehlen.";
  return null;
}

export function isOcrMock(s: OcrSettings, env: { mode?: string } = { mode: process.env.INTEGRATIONS_MODE }) {
  return env.mode === "mock" || s.mode === "mock";
}

/** Adapter für die Praxis; wirft OcrNotConfiguredError, wenn die Funktion nicht freigegeben ist. */
export function ocrAdapter(s: OcrSettings, organizationId: string, opts: { fetch?: FetchLike; mode?: string } = {}): OcrPort {
  const env = { mode: opts.mode ?? process.env.INTEGRATIONS_MODE };
  const blocker = ocrBlocker(s, env);
  if (blocker) throw new OcrNotConfiguredError(blocker);
  if (isOcrMock(s, env)) return new OcrMock();
  const baseUrl = assertSafeUrlSyntax(s.baseUrl!).toString().replace(/\/$/, "");
  const { apiKey } = decryptJson<{ apiKey?: string }>(s.apiKeyEnc!, { aad: organizationId });
  return new OpenAiVisionOcr({
    baseUrl,
    apiKey,
    model: s.model,
    imageStyle: s.imageStyle,
    dataProcessingApproved: consentValid(s),
    // SSRF-Schutz: https, keine privaten Ziele, keine Weiterleitungen
    fetch: guardedFetch(opts.fetch),
  });
}
