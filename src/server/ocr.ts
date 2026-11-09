import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { media, organizations } from "@/db/schema";
import { OcrNotConfiguredError, type OcrImage } from "@/integrations/ocr/ocr";
import { OcrOutputError, type OcrSuggestion } from "@/integrations/ocr/schema";
import { OCR_CONSENT_VERSION, consentValid, isOcrMock, ocrAdapter, ocrBlocker, parseOcrSettings, type OcrSettings } from "@/integrations/ocr/settings";
import { assertPublicUrl, UnsafeTargetError } from "@/integrations/net-guard";
import { describeError } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { encryptJson } from "@/lib/crypto";
import { createRateLimiter } from "@/lib/rate-limit";
import { readDecrypted, sniffMime } from "@/lib/storage";
import { assertCan } from "./authz";
import { gkvGuard } from "@/lib/features";
import { logSync } from "./integrations";

/** Je Praxis: Grenze pro Minute (Doppelklicks, Skripte) zusätzlich zur Stundenquote aus den Einstellungen. */
const perMinute = createRateLimiter({ windowMs: 60_000, max: 6, maxKeys: 5000 });
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function loadOcrSettings(organizationId: string): Promise<OcrSettings> {
  // organizations hat keine RLS → nur über die Praxis-ID aus der Sitzung lesen
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId));
  return parseOcrSettings((o?.settings as Record<string, unknown> | undefined)?.ocr);
}

async function storeOcrSettings(organizationId: string, s: OcrSettings) {
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('ocr', ${JSON.stringify(s)}::jsonb)` })
    .where(eq(organizations.id, organizationId));
}

/** Für das Verordnungsformular: darf die Schaltfläche „Auslesen“ erscheinen? */
export async function ocrStatus(auth: AuthContext): Promise<{ available: boolean; mock: boolean; reason: string | null }> {
  const s = await loadOcrSettings(auth.organization.id);
  const reason = ocrBlocker(s);
  return { available: !reason && auth.can("medical.write"), mock: isOcrMock(s), reason };
}

/** Ansicht für die Einstellungsseite (ohne Geheimnis) */
export async function ocrSettingsView(auth: AuthContext) {
  assertCan(auth, "settings.manage");
  const s = await loadOcrSettings(auth.organization.id);
  return {
    enabled: s.enabled,
    mode: s.mode,
    baseUrl: s.baseUrl ?? "",
    model: s.model ?? "",
    imageStyle: s.imageStyle,
    hasKey: !!s.apiKeyEnc,
    perHour: s.perHour,
    consent: consentValid(s) ? { at: s.consent!.at } : null,
    blocker: ocrBlocker(s),
    envMock: process.env.INTEGRATIONS_MODE === "mock",
  };
}

export type OcrSettingsInput = {
  enabled: boolean;
  mode: "mock" | "live";
  baseUrl?: string;
  model?: string;
  imageStyle: "openai" | "string";
  apiKey?: string;
  clearKey?: boolean;
  perHour: number;
  /** alle drei Bestätigungen angehakt */
  confirm: { avv: boolean; subprocessor: boolean; dataLeavesPractice: boolean };
};

/** Nur die Inhaber:in darf die Funktion einschalten bzw. den Anbieter ändern. */
export async function saveOcrSettings(auth: AuthContext, input: OcrSettingsInput): Promise<{ ok: string } | { error: string }> {
  assertCan(auth, "settings.manage");
  if (auth.role !== "owner" || auth.support) return { error: "Nur die Inhaber:in der Praxis kann die Verordnungs-OCR einrichten." };
  const blocked = gkvGuard(auth.organization, "ocr");
  if (blocked) return blocked;
  const org = auth.organization.id;
  const old = await loadOcrSettings(org);
  const next: OcrSettings = { ...old, enabled: input.enabled, mode: input.mode, imageStyle: input.imageStyle, perHour: input.perHour };

  let baseUrl: string | undefined;
  if (input.baseUrl) {
    try {
      baseUrl = (await assertPublicUrl(input.baseUrl)).toString().replace(/\/$/, "");
    } catch (e) {
      return { error: e instanceof UnsafeTargetError ? e.message : "Adresse des Auslesedienstes ist nicht erlaubt." };
    }
  }
  const targetChanged = (old.baseUrl ?? null) !== (baseUrl ?? null);
  next.baseUrl = baseUrl;
  next.model = input.model || undefined;
  // Neues Ziel → alter Schlüssel und alte Bestätigung gelten nicht mehr (neuer Anbieter = neuer AVV)
  if (targetChanged) {
    next.apiKeyEnc = undefined;
    next.consent = undefined;
  }
  if (input.clearKey) next.apiKeyEnc = undefined;
  if (input.apiKey) next.apiKeyEnc = encryptJson({ apiKey: input.apiKey }, { aad: org });

  const allConfirmed = input.confirm.avv && input.confirm.subprocessor && input.confirm.dataLeavesPractice;
  if (allConfirmed && !consentValid(next)) {
    next.consent = { at: new Date().toISOString(), by: auth.user.id, version: OCR_CONSENT_VERSION, avv: true, subprocessor: true, dataLeavesPractice: true };
  }
  if (next.enabled && next.mode === "live") {
    if (!consentValid(next)) return { error: "Für den echten Dienst bitte alle drei Punkte zum Datenschutz bestätigen." };
    if (!next.baseUrl || !next.model || !next.apiKeyEnc) return { error: "Für den echten Dienst bitte Adresse, Modell und API-Schlüssel angeben." };
  }
  await storeOcrSettings(org, next);
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "settings.ocr",
    meta: { enabled: next.enabled, mode: next.mode, host: next.baseUrl ? new URL(next.baseUrl).host : null, model: next.model ?? null, keyChanged: !!input.apiKey || !!input.clearKey || targetChanged, consent: consentValid(next) },
  });
  return { ok: next.enabled ? (next.mode === "mock" ? "Gespeichert – Testmodus aktiv (Beispieldaten, nichts verlässt die Praxis)." : "Gespeichert – Verordnungs-OCR ist eingeschaltet.") : "Gespeichert – Verordnungs-OCR ist ausgeschaltet." };
}

/**
 * Liest das (bereits verschlüsselt gespeicherte) Foto einer Verordnung aus.
 * Speichert NICHTS an der Verordnung – das passiert erst mit „Übernehmen“ im Formular.
 */
export async function extractPrescriptionFromMedia(
  auth: AuthContext,
  input: { patientId: string; mediaId: string },
): Promise<{ suggestion: OcrSuggestion; mock: boolean } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "ocr");
  if (blocked) return blocked;
  const org = auth.organization.id;
  const settings = await loadOcrSettings(org);
  const blocker = ocrBlocker(settings);
  if (blocker) return { error: blocker };
  if (perMinute.limited(org) || hourlyQuotaExceeded(org, settings.perHour)) {
    return { error: "Zu viele Auslesungen in kurzer Zeit – bitte etwas warten oder manuell erfassen." };
  }

  const [m] = await withOrg(org, (tx) =>
    tx
      .select({ storageKey: media.storageKey, sizeBytes: media.sizeBytes })
      .from(media)
      .where(and(eq(media.organizationId, org), eq(media.id, input.mediaId), eq(media.patientId, input.patientId), eq(media.purpose, "prescription"), isNull(media.deletedAt))),
  );
  if (!m) return { error: "Foto der Verordnung nicht gefunden." };
  if (m.sizeBytes > MAX_IMAGE_BYTES) return { error: "Foto ist zu groß zum Auslesen (max. 10 MB)." };
  const data = await readDecrypted(m.storageKey);
  const mime = sniffMime(data);
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") {
    return { error: "Auslesen geht nur mit Fotos (JPEG, PNG oder WebP) – PDF/HEIC bitte manuell erfassen." };
  }
  const image: OcrImage = { data: new Uint8Array(data), mime };
  const started = Date.now();
  const mock = isOcrMock(settings);
  try {
    const suggestion = await ocrAdapter(settings, org).extractPrescription(image);
    // Kein PHI im Protokoll: nur Anzahl/Namen der Felder, Dauer, Modus
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: "prescription.ocr",
      entity: "patient",
      entityId: input.patientId,
      meta: { mock, ok: true, fields: Object.keys(suggestion.fields).length, rejected: suggestion.rejected, ms: Date.now() - started, bytes: data.length },
    });
    return { suggestion, mock };
  } catch (e) {
    await audit({ organizationId: org, userId: auth.user.id, action: "prescription.ocr", entity: "patient", entityId: input.patientId, meta: { mock, ok: false, ms: Date.now() - started } });
    if (e instanceof OcrOutputError || e instanceof OcrNotConfiguredError) return { error: e.message };
    // Fehlermeldung des Anbieters nur ins Schnittstellenprotokoll (ohne Bildinhalt)
    await logSync(org, "llm", { direction: "out", ok: false, message: `Verordnungs-OCR: ${describeError(e)}` }).catch(() => undefined);
    return { error: "Der Auslesedienst ist gerade nicht erreichbar. Bitte später erneut versuchen oder manuell erfassen." };
  }
}

/** Stundenquote je Praxis (prozesslokal, gleitendes Fenster); zählt nur zugelassene Aufrufe. */
const hourly = new Map<string, number[]>();
export function hourlyQuotaExceeded(org: string, max: number, now = Date.now()): boolean {
  const list = (hourly.get(org) ?? []).filter((t) => now - t < 60 * 60_000);
  hourly.delete(org);
  hourly.set(org, list);
  if (hourly.size > 5000) {
    const oldest = hourly.keys().next().value;
    if (oldest !== undefined) hourly.delete(oldest);
  }
  if (list.length >= max) return true;
  list.push(now);
  return false;
}
