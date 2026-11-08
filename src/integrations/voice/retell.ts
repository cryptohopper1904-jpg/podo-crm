/**
 * Retell-AI-Adapter (https://docs.retellai.com).
 *
 * Retell ruft dieselbe Adresse /api/voice/retell?org=<uuid> für zwei Dinge auf:
 *  - Custom Functions (Werkzeuge): POST { name, args, call: { call_id, from_number, … } }
 *    → Antwort (HTTP 200) wird dem Sprachmodell als Ergebnis gegeben: { result: "<Text>" }
 *  - Agent-Webhook: POST { event: "call_started" | "call_ended" | "call_analyzed", call: { … } }
 *    call_ended: start_timestamp/end_timestamp (ms), duration_ms, disconnection_reason, transcript
 *    call_analyzed: zusätzlich call_analysis.call_summary
 *
 * Echtheit: Header `x-retell-signature` = HMAC-SHA256 über den unveränderten Body mit dem
 * API-Schlüssel der Praxis (Retell-Konto). Aktuelles Format „v=<ms-Zeitstempel>,d=<hex>“ mit
 * HMAC über body + Zeitstempel (Retell-SDK `verify`, max. 5 Minuten Abweichung → kein Replay).
 * Das ältere Format ohne Zeitstempel (reiner Hex-Digest) wird NICHT akzeptiert (unbegrenzt wiederholbar).
 * Vergleich zeitkonstant, ohne Schlüssel immer false.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { VoiceAgentPort, VoiceCallEvent, VoiceToolCall, VoiceToolResult } from "../types";

export const RETELL_SIGNATURE_HEADER = "x-retell-signature";
/** Erlaubte Abweichung des Zeitstempels in der Signatur */
export const RETELL_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function hexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const x = Buffer.from(a.toLowerCase(), "hex");
  const y = Buffer.from(b.toLowerCase(), "hex");
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

/**
 * Prüft `x-retell-signature`. Reine Funktion (testbar): `now` für die Zeitfenster-Prüfung.
 */
export function verifyRetellSignature(rawBody: string | undefined, apiKey: string | null | undefined, signature: string | null | undefined, now = Date.now()): boolean {
  if (rawBody === undefined || !apiKey || !signature) return false;
  const sig = signature.trim();
  const m = /^v=(\d{10,16}),d=([0-9a-fA-F]{64})$/.exec(sig);
  if (m) {
    const ts = Number(m[1]);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > RETELL_SIGNATURE_TOLERANCE_MS) return false;
    const digest = createHmac("sha256", apiKey).update(rawBody + m[1]).digest("hex");
    return hexEqual(digest, m[2]);
  }
  return false;
}

/** Signatur erzeugen (Testanruf-Simulation und Tests). */
export function signRetellBody(rawBody: string, apiKey: string, now = Date.now()): string {
  const ts = String(Math.floor(now));
  return `v=${ts},d=${createHmac("sha256", apiKey).update(rawBody + ts).digest("hex")}`;
}

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

const isoFromMs = (v: unknown): string | null => {
  const n = num(v);
  return n !== null && n > 0 ? new Date(n).toISOString() : null;
};

/** Retell sendet keine Tool-Call-ID → stabile ID aus Anruf, Werkzeug und Argumenten. */
function toolCallId(callId: string, name: string, args: Obj): string {
  return `retell-${createHash("sha256").update(`${callId}|${name}|${JSON.stringify(args)}`).digest("hex").slice(0, 24)}`;
}

export function parseRetellEvent(payload: unknown): VoiceCallEvent {
  const p = obj(payload);
  const call = obj(p.call);
  const callId = (str(call.call_id) ?? str(p.call_id) ?? "").slice(0, 200);
  const from = str(call.from_number);
  // Custom Function
  if (typeof p.name === "string" && !("event" in p)) {
    if (!callId) return { type: "unknown", raw: payload };
    const name = p.name.slice(0, 100);
    const args = parseArgs(p.args);
    const calls: VoiceToolCall[] = name ? [{ toolCallId: toolCallId(callId, name, args), tool: name, args }] : [];
    return { type: "tool_calls", callId, from, calls };
  }
  switch (p.event) {
    case "call_started":
      if (!callId) return { type: "unknown", raw: payload };
      return { type: "status", callId, from, status: "in-progress" };
    case "call_ended":
    case "call_analyzed": {
      if (!callId) return { type: "unknown", raw: payload };
      const startedAt = isoFromMs(call.start_timestamp);
      const endedAt = isoFromMs(call.end_timestamp);
      let durationSec: number | null = null;
      const ms = num(call.duration_ms);
      if (ms !== null && ms >= 0) durationSec = ms / 1000;
      else if (num(call.start_timestamp) !== null && num(call.end_timestamp) !== null) {
        const d = (num(call.end_timestamp)! - num(call.start_timestamp)!) / 1000;
        durationSec = d >= 0 ? d : null;
      }
      return {
        type: "call_ended",
        callId,
        from,
        startedAt,
        endedAt,
        durationSec: durationSec === null ? null : Math.round(durationSec),
        endedReason: str(call.disconnection_reason),
        summary: str(obj(call.call_analysis).call_summary),
        transcript: str(call.transcript),
      };
    }
    default:
      return { type: "unknown", raw: payload };
  }
}

export class RetellVoiceAgent implements VoiceAgentPort {
  readonly provider = "voice_agent" as const;
  readonly vendor = "retell" as const;
  readonly isMock: boolean = false;

  /** API-Schlüssel des Retell-Kontos der Praxis (signiert alle Aufrufe). */
  static apiKey(secret: Record<string, string>): string | null {
    return secret.retellApiKey || null;
  }

  verify(headers: Record<string, string | undefined>, secret: Record<string, string>, rawBody?: string): boolean {
    return verifyRetellSignature(rawBody, RetellVoiceAgent.apiKey(secret), headers[RETELL_SIGNATURE_HEADER]);
  }

  parseEvent(payload: unknown): VoiceCallEvent {
    return parseRetellEvent(payload);
  }

  /** Retell erwartet je Funktionsaufruf genau ein Ergebnis. */
  formatToolResults(results: VoiceToolResult[]) {
    return { result: results.map((r) => r.result).join("\n\n") };
  }
}
