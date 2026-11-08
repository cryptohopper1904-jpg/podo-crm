/**
 * Vapi-Adapter (Server-URL-Muster, https://docs.vapi.ai/server-url/events).
 *
 * Vapi sendet POST { message: { type, call, … } } an /api/voice/vapi?org=<uuid>:
 *  - "tool-calls":          message.toolCallList[] = { id, type: "function", function: { name, arguments } }
 *                           → Antwort { results: [{ toolCallId, result }] } (synchron)
 *  - "end-of-call-report":  message.endedReason, message.durationSeconds, message.analysis.summary,
 *                           message.artifact.transcript
 *  - "status-update":       message.status ("in-progress", "ended", …)
 *
 * Echtheit: Header `x-vapi-secret` (im Vapi-Assistenten als „Server URL Secret“ hinterlegt) muss dem
 * Geheimnis der Praxis entsprechen (verschlüsselt in integration_connections, zeitkonstanter Vergleich).
 */
import { safeEqual } from "@/lib/safe-equal";
import type { VoiceAgentPort, VoiceCallEvent, VoiceToolCall, VoiceToolResult } from "../types";

export const VAPI_SECRET_HEADER = "x-vapi-secret";
/** Mehr Werkzeug-Aufrufe pro Anfrage werden nicht ausgeführt (Missbrauchsschutz). */
export const MAX_TOOL_CALLS_PER_REQUEST = 5;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseArgs(raw: unknown): Obj {
  if (typeof raw === "string") {
    if (raw.length > 10_000) return {};
    try {
      return obj(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return obj(raw);
}

function toolCalls(m: Obj): VoiceToolCall[] {
  const list = Array.isArray(m.toolCallList)
    ? m.toolCallList
    : Array.isArray(m.toolWithToolCallList)
      ? m.toolWithToolCallList.map((t) => obj(t).toolCall)
      : [];
  return list.slice(0, MAX_TOOL_CALLS_PER_REQUEST).flatMap((raw): VoiceToolCall[] => {
    const c = obj(raw);
    const fn = obj(c.function);
    const id = str(c.id);
    const name = str(fn.name) ?? str(c.name);
    if (!id || !name) return [];
    return [{ toolCallId: id.slice(0, 200), tool: name.slice(0, 100), args: parseArgs(fn.arguments ?? c.arguments) }];
  });
}

export function parseVapiEvent(payload: unknown): VoiceCallEvent {
  const m = obj(obj(payload).message);
  const call = obj(m.call);
  const callId = (str(call.id) ?? str(m.callId) ?? "").slice(0, 200);
  const from = str(obj(call.customer).number) ?? str(obj(m.customer).number);
  switch (m.type) {
    case "tool-calls":
      if (!callId) return { type: "unknown", raw: payload };
      return { type: "tool_calls", callId, from, calls: toolCalls(m) };
    case "end-of-call-report": {
      if (!callId) return { type: "unknown", raw: payload };
      const startedAt = str(m.startedAt) ?? str(call.startedAt);
      const endedAt = str(m.endedAt) ?? str(call.endedAt);
      let durationSec = num(m.durationSeconds);
      if (durationSec === null && startedAt && endedAt) {
        const d = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
        durationSec = Number.isFinite(d) && d >= 0 ? d : null;
      }
      const artifact = obj(m.artifact);
      return {
        type: "call_ended",
        callId,
        from,
        startedAt,
        endedAt,
        durationSec: durationSec === null ? null : Math.round(durationSec),
        endedReason: str(m.endedReason) ?? str(call.endedReason),
        summary: str(obj(m.analysis).summary) ?? str(m.summary),
        transcript: str(artifact.transcript) ?? str(m.transcript),
      };
    }
    case "status-update":
      if (!callId) return { type: "unknown", raw: payload };
      return { type: "status", callId, from, status: str(m.status) ?? "unknown" };
    default:
      return { type: "unknown", raw: payload };
  }
}

export class VapiVoiceAgent implements VoiceAgentPort {
  readonly provider = "voice_agent" as const;
  readonly vendor = "vapi" as const;
  readonly isMock: boolean = false;

  /** Geheimnis: `vapiSecret` (falls eigens gesetzt), sonst das automatisch erzeugte `webhookToken` der Praxis. */
  static sharedSecret(secret: Record<string, string>): string | null {
    return secret.vapiSecret || secret.webhookToken || null;
  }

  verify(headers: Record<string, string | undefined>, secret: Record<string, string>): boolean {
    const expected = VapiVoiceAgent.sharedSecret(secret);
    if (!expected) return false;
    return safeEqual(headers[VAPI_SECRET_HEADER], expected);
  }

  parseEvent(payload: unknown): VoiceCallEvent {
    return parseVapiEvent(payload);
  }

  formatToolResults(results: VoiceToolResult[]) {
    return { results: results.map((r) => ({ toolCallId: r.toolCallId, result: r.result })) };
  }
}
