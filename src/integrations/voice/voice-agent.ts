/**
 * KI-Telefonagent (PLAN 4.6 / 6.9) – Pilot.
 *
 * Anbieterneutraler Kern: src/integrations/voice/core.ts (Werkzeuge, Validierung, Texte) und
 * src/server/voice.ts (Datenbank). Je Anbieter gibt es hier nur einen schlanken Adapter, der
 *  - die Echtheit eines Aufrufs prüft (fail closed),
 *  - die Payload in ein `VoiceCallEvent` übersetzt und
 *  - die Werkzeug-Ergebnisse im Anbieterformat zurückgibt.
 *
 * Umgesetzt: Vapi (https://docs.vapi.ai/server-url) und Retell AI (https://docs.retellai.com).
 * Fonio und sipgate AI Flow folgen demselben Muster (eigene Klasse + Eintrag in `voiceAgentFor`).
 */
import { IntegrationNotConfiguredError } from "../errors";
import type { VoiceAgentPort, VoiceVendorId } from "../types";
import { RetellVoiceAgent } from "./retell";
import { VapiVoiceAgent } from "./vapi";

export { RetellVoiceAgent, VapiVoiceAgent };

export const VOICE_VENDORS: readonly VoiceVendorId[] = ["vapi", "retell", "fonio", "sipgate"];
/** Anbieter mit fertigem Adapter (nur diese werden unter /api/voice/{vendor} angenommen). */
export const IMPLEMENTED_VOICE_VENDORS: readonly VoiceVendorId[] = ["vapi", "retell"];
export const VOICE_VENDOR_LABEL: Record<VoiceVendorId, string> = { vapi: "Vapi", retell: "Retell AI", fonio: "Fonio", sipgate: "sipgate AI Flow" };
export const isImplementedVoiceVendor = (v: unknown): v is "vapi" | "retell" => typeof v === "string" && (IMPLEMENTED_VOICE_VENDORS as readonly string[]).includes(v);

export const isVoiceVendor = (v: unknown): v is VoiceVendorId => typeof v === "string" && (VOICE_VENDORS as readonly string[]).includes(v);

/** Echter Adapter für einen Anbieter. Nicht umgesetzte Anbieter → IntegrationNotConfiguredError. */
export function voiceAgentFor(vendor: string | null | undefined): VoiceAgentPort {
  const v = vendor || "vapi";
  if (!isVoiceVendor(v)) throw new IntegrationNotConfiguredError("voice_agent", `Unbekannter Anbieter „${v}“`);
  if (v === "vapi") return new VapiVoiceAgent();
  if (v === "retell") return new RetellVoiceAgent();
  throw new IntegrationNotConfiguredError("voice_agent", `Anbieter „${v}“ noch nicht umgesetzt (verfügbar: Vapi, Retell AI)`);
}

/** Konfigurierter Anbieter einer Verbindung (Standard: vapi). */
export const configuredVoiceVendor = (config: Record<string, unknown> | null | undefined): VoiceVendorId => {
  const v = config?.vendor;
  return isVoiceVendor(v) ? v : "vapi";
};

/** Testmodus: gleiches Format und gleiche Prüfung wie Vapi, nur als Mock gekennzeichnet. */
export class VoiceAgentMock extends VapiVoiceAgent {
  override readonly isMock: boolean = true;
}
