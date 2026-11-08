/**
 * KI-Telefonagent (PLAN 4.6 / 6.9) – P2, in P1 nur Platzhalter.
 *
 * Vendoren: Vapi (https://docs.vapi.ai), Retell (https://docs.retellai.com), Fonio (https://fonio.ai),
 * Telefonie über sipgate/Placetel. Der Agent ruft über Tool-Endpunkte CRM-Funktionen auf:
 * Verfügbarkeit prüfen, Termin buchen, Termin absagen (siehe VoiceToolHandlers).
 * Datenschutz: Einwilligung „call_recording“, Hinweis zu Beginn des Gesprächs, EU-Verarbeitung.
 * TODO: Vendor-spezifische Payloads und Signaturprüfung je Anbieter.
 */
import { IntegrationNotConfiguredError } from "../errors";
import type { VoiceAgentPort, VoiceCallEvent, VoiceTool, VoiceToolHandlers } from "../types";

const TOOLS: VoiceTool[] = ["check_availability", "book_appointment", "cancel_appointment"];

/**
 * Generisches Ereignisformat (auch vom Mock genutzt):
 *  { type: "call_started", callId, from, at } | { type: "call_ended", callId, durationSec, summary, at }
 *  { type: "tool_call", callId, toolCallId, tool, args }
 */
export function parseGenericVoiceEvent(payload: unknown): VoiceCallEvent {
  const p = (payload ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  switch (p.type) {
    case "call_started":
      return { type: "call_started", callId: s("callId") ?? "", from: s("from"), at: s("at") ?? new Date().toISOString() };
    case "call_ended":
      return {
        type: "call_ended",
        callId: s("callId") ?? "",
        durationSec: typeof p.durationSec === "number" ? p.durationSec : null,
        summary: s("summary"),
        at: s("at") ?? new Date().toISOString(),
      };
    case "tool_call": {
      const tool = s("tool") as VoiceTool | null;
      if (tool && TOOLS.includes(tool)) {
        return { type: "tool_call", callId: s("callId") ?? "", toolCallId: s("toolCallId") ?? "", tool, args: (p.args as Record<string, unknown>) ?? {} };
      }
      return { type: "unknown", raw: payload };
    }
    default:
      return { type: "unknown", raw: payload };
  }
}

export async function runVoiceTool(event: Extract<VoiceCallEvent, { type: "tool_call" }>, h: VoiceToolHandlers): Promise<unknown> {
  const a = event.args as Record<string, string | undefined>;
  switch (event.tool) {
    case "check_availability":
      return h.checkAvailability({ from: a.from ?? "", to: a.to ?? "", serviceCode: a.serviceCode });
    case "book_appointment":
      return h.bookAppointment({ startsAt: a.startsAt ?? "", name: a.name ?? "", phone: a.phone, serviceCode: a.serviceCode });
    case "cancel_appointment":
      return h.cancelAppointment({ reference: a.reference, phone: a.phone, startsAt: a.startsAt });
  }
}

export class VoiceAgentAdapter implements VoiceAgentPort {
  readonly provider = "voice_agent" as const;
  readonly isMock = false;
  constructor(opts: { vendor?: "vapi" | "retell" | "fonio" | "sipgate" | null; apiKey?: string | null }) {
    if (!opts.vendor || !opts.apiKey) throw new IntegrationNotConfiguredError("voice_agent", "Anbieter und API-Key fehlen (P2)");
    throw new IntegrationNotConfiguredError("voice_agent", `Anbieter „${opts.vendor}“ noch nicht implementiert (P2, TODO)`);
  }
  parseEvent(): VoiceCallEvent {
    throw new IntegrationNotConfiguredError("voice_agent");
  }
  async handleToolCall(): Promise<unknown> {
    throw new IntegrationNotConfiguredError("voice_agent");
  }
}

export class VoiceAgentMock implements VoiceAgentPort {
  readonly provider = "voice_agent" as const;
  readonly isMock = true;
  parseEvent(payload: unknown) {
    return parseGenericVoiceEvent(payload);
  }
  async handleToolCall(event: Extract<VoiceCallEvent, { type: "tool_call" }>, handlers: VoiceToolHandlers) {
    return { toolCallId: event.toolCallId, result: await runVoiceTool(event, handlers) };
  }
}
