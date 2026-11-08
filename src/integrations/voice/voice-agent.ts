/**
 * KI-Telefonagent (PLAN 4.6 / 6.9) – Pilot.
 *
 * Anbieterneutraler Kern: src/integrations/voice/core.ts (Werkzeuge, Validierung, Texte) und
 * src/server/voice.ts (Datenbank). Je Anbieter gibt es hier nur einen schlanken Adapter, der
 *  - die Echtheit eines Aufrufs prüft (fail closed),
 *  - die Payload in ein `VoiceCallEvent` übersetzt und
 *  - die Werkzeug-Ergebnisse im Anbieterformat zurückgibt.
 *
 * Umgesetzt: Vapi (https://docs.vapi.ai/server-url). Retell, Fonio und sipgate AI Flow folgen demselben
 * Muster (eigene Klasse + Eintrag in `voiceAgentFor`).
 */
import { IntegrationNotConfiguredError } from "../errors";
import type { VoiceVendorId } from "../types";
import { VapiVoiceAgent } from "./vapi";

export { VapiVoiceAgent };

export const VOICE_VENDORS: readonly VoiceVendorId[] = ["vapi", "retell", "fonio", "sipgate"];
/** Anbieter mit fertigem Adapter (nur diese werden unter /api/voice/{vendor} angenommen). */
export const IMPLEMENTED_VOICE_VENDORS: readonly VoiceVendorId[] = ["vapi"];

export const isVoiceVendor = (v: unknown): v is VoiceVendorId => typeof v === "string" && (VOICE_VENDORS as readonly string[]).includes(v);

/** Echter Adapter für einen Anbieter. Nicht umgesetzte Anbieter → IntegrationNotConfiguredError. */
export function voiceAgentFor(vendor: string | null | undefined): VapiVoiceAgent {
  const v = vendor || "vapi";
  if (!isVoiceVendor(v)) throw new IntegrationNotConfiguredError("voice_agent", `Unbekannter Anbieter „${v}“`);
  if (v === "vapi") return new VapiVoiceAgent();
  throw new IntegrationNotConfiguredError("voice_agent", `Anbieter „${v}“ noch nicht umgesetzt (Pilot: vapi)`);
}

/** Testmodus: gleiches Format und gleiche Prüfung wie Vapi, nur als Mock gekennzeichnet. */
export class VoiceAgentMock extends VapiVoiceAgent {
  override readonly isMock: boolean = true;
}
