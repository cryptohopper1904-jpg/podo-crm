/** KI-Telefon: Retell-Adapter (Signatur, Parser, Werkzeug-Abbildung), Assistenten-Vorlagen, Minutenkontingent im Kern. */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { retellAgentConfig, vapiAssistantConfig } from "./assistant-config";
import { QUOTA_INBOX_SUBJECT, runVoiceTools, VOICE_TOOLS, type VoiceToolDeps } from "./core";
import { parseRetellEvent, RETELL_SIGNATURE_HEADER, RetellVoiceAgent, signRetellBody, verifyRetellSignature } from "./retell";
import { voiceAgentFor } from "./voice-agent";

const KEY = "key_test_0000000000000000000000";
const NOW = Date.parse("2030-03-04T07:00:00Z");
const body = JSON.stringify({ name: "praxis_info", args: {}, call: { call_id: "c1", from_number: "+4915100000023" } });

describe("Retell: x-retell-signature (HMAC-SHA256, fail closed)", () => {
  it("gültige Signatur (v=<ts>,d=<hex>) wird akzeptiert", () => {
    expect(verifyRetellSignature(body, KEY, signRetellBody(body, KEY, NOW), NOW)).toBe(true);
  });

  it("älteres Format ohne Zeitstempel (reiner Hex-Digest) wird abgelehnt – kein unbegrenzter Replay", () => {
    const legacy = createHmac("sha256", KEY).update(body).digest("hex");
    expect(verifyRetellSignature(body, KEY, legacy, NOW)).toBe(false);
    expect(verifyRetellSignature(body, KEY, `d=${legacy}`, NOW)).toBe(false);
  });

  it("veränderter Body, falscher Schlüssel, manipulierter Digest oder Zeitstempel → abgelehnt", () => {
    const sig = signRetellBody(body, KEY, NOW);
    expect(verifyRetellSignature(body.replace("praxis_info", "termin_buchen"), KEY, sig, NOW)).toBe(false);
    expect(verifyRetellSignature(`${body} `, KEY, sig, NOW)).toBe(false);
    expect(verifyRetellSignature(body, "key_other_000000000000000000000", sig, NOW)).toBe(false);
    const flipped = sig.replace(/d=(.)/, (_, c: string) => `d=${c === "a" ? "b" : "a"}`);
    expect(verifyRetellSignature(body, KEY, flipped, NOW)).toBe(false);
    // Zeitstempel ausgetauscht (Digest passt nicht mehr)
    expect(verifyRetellSignature(body, KEY, sig.replace(/v=\d+/, `v=${NOW + 1000}`), NOW)).toBe(false);
  });

  it("Replay außerhalb von 5 Minuten wird abgelehnt", () => {
    const sig = signRetellBody(body, KEY, NOW);
    expect(verifyRetellSignature(body, KEY, sig, NOW + 4 * 60_000)).toBe(true);
    expect(verifyRetellSignature(body, KEY, sig, NOW + 6 * 60_000)).toBe(false);
    expect(verifyRetellSignature(body, KEY, sig, NOW - 6 * 60_000)).toBe(false);
  });

  it("ohne Schlüssel, ohne Header, ohne Body oder mit Unsinn → immer false", () => {
    const sig = signRetellBody(body, KEY, NOW);
    expect(verifyRetellSignature(body, "", sig, NOW)).toBe(false);
    expect(verifyRetellSignature(body, null, sig, NOW)).toBe(false);
    expect(verifyRetellSignature(body, KEY, undefined, NOW)).toBe(false);
    expect(verifyRetellSignature(undefined, KEY, sig, NOW)).toBe(false);
    expect(verifyRetellSignature(body, KEY, "v=abc,d=xyz", NOW)).toBe(false);
    expect(verifyRetellSignature(body, KEY, "", NOW)).toBe(false);
  });

  it("Port: verify nutzt den hinterlegten retellApiKey und den Roh-Body", () => {
    const port = new RetellVoiceAgent();
    const headers = { [RETELL_SIGNATURE_HEADER]: signRetellBody(body, KEY) };
    expect(port.verify(headers, { retellApiKey: KEY }, body)).toBe(true);
    expect(port.verify(headers, { retellApiKey: KEY })).toBe(false); // ohne Body
    expect(port.verify(headers, { webhookToken: KEY }, body)).toBe(false); // nur Retell-Schlüssel zählt
    expect(port.verify({}, { retellApiKey: KEY }, body)).toBe(false);
  });
});

describe("Retell: Ereignisse → neutrales Format", () => {
  it("Custom Function { name, args, call } → tool_calls mit stabiler ID", () => {
    const p = { name: "freie_termine", args: { von: "2030-03-05", leistung: "PK" }, call: { call_id: "call_1", from_number: "+4915100000023" } };
    const ev = parseRetellEvent(p);
    expect(ev).toMatchObject({ type: "tool_calls", callId: "call_1", from: "+4915100000023", calls: [{ tool: "freie_termine", args: { von: "2030-03-05", leistung: "PK" } }] });
    if (ev.type !== "tool_calls") throw new Error();
    expect(ev.calls[0].toolCallId).toBe((parseRetellEvent(p) as typeof ev).calls[0].toolCallId);
    expect(parseRetellEvent({ name: "freie_termine", args: "{\"von\":\"2030-03-05\"}", call: { call_id: "c" } })).toMatchObject({ calls: [{ args: { von: "2030-03-05" } }] });
    expect(parseRetellEvent({ name: "x", args: "kein json", call: { call_id: "c" } })).toMatchObject({ calls: [{ args: {} }] });
  });

  it("call_ended / call_analyzed → call_ended mit Dauer, Grund, Zusammenfassung, Transkript", () => {
    const call = { call_id: "call_2", from_number: "+4915100000023", start_timestamp: NOW, end_timestamp: NOW + 125_400, disconnection_reason: "user_hangup", transcript: "Agent: Hallo" };
    expect(parseRetellEvent({ event: "call_ended", call })).toMatchObject({ type: "call_ended", callId: "call_2", durationSec: 125, endedReason: "user_hangup", transcript: "Agent: Hallo", summary: null, startedAt: new Date(NOW).toISOString() });
    expect(parseRetellEvent({ event: "call_analyzed", call: { ...call, duration_ms: 61_000, call_analysis: { call_summary: "Rückrufbitte." } } })).toMatchObject({ durationSec: 61, summary: "Rückrufbitte." });
    expect(parseRetellEvent({ event: "call_started", call })).toMatchObject({ type: "status", status: "in-progress" });
  });

  it("ohne Call-ID oder unbekannt → unknown", () => {
    expect(parseRetellEvent({ name: "praxis_info", args: {} }).type).toBe("unknown");
    expect(parseRetellEvent({ event: "call_ended", call: {} }).type).toBe("unknown");
    expect(parseRetellEvent({ event: "transcript_updated", call: { call_id: "c" } }).type).toBe("unknown");
    expect(parseRetellEvent(null).type).toBe("unknown");
  });

  it("Antwortformat { result } und Fabrik", () => {
    expect(new RetellVoiceAgent().formatToolResults([{ toolCallId: "t", result: "ok" }])).toEqual({ result: "ok" });
    expect(voiceAgentFor("retell")).toBeInstanceOf(RetellVoiceAgent);
  });
});

function deps(over: Partial<VoiceToolDeps> = {}) {
  const log = { inbox: [] as { subject: string; body: string; from: string | null }[], outcomes: [] as string[], book: 0, slots: 0 };
  const d: VoiceToolDeps = {
    now: () => new Date(NOW),
    caller: "+4915100000023",
    services: async () => [{ code: "PK", name: "Podologische Komplexbehandlung", durationMin: 40 }],
    findSlots: async () => {
      log.slots++;
      return [new Date(Date.parse("2030-03-05T08:00:00Z"))];
    },
    book: async () => {
      log.book++;
      return { status: "booked", appointmentId: "a1" };
    },
    inbox: async (i) => {
      log.inbox.push(i);
    },
    practiceInfo: async () => ({ name: "Testpraxis", address: null, phone: null, openingText: "Mo–Fr" }),
    noteOutcome: async (o) => {
      log.outcomes.push(o);
    },
    ...over,
  };
  return { d, log };
}

describe("Retell-Werkzeug → neutraler Kern", () => {
  it("Retell-Funktionsaufruf wird wie bei Vapi ausgeführt", async () => {
    const ev = parseRetellEvent({ name: "freie_termine", args: { von: "2030-03-05", leistung: "PK" }, call: { call_id: "c" } });
    if (ev.type !== "tool_calls") throw new Error();
    const { d, log } = deps();
    const [r] = await runVoiceTools(ev.calls, d);
    expect(r.result).toMatch(/termin=2030-03-05T08:00:00.000Z/);
    expect(log.slots).toBe(1);
  });
});

describe("Minutenkontingent im Kern", () => {
  it("erschöpft: freie_termine/termin_buchen → höfliche Absage + eine Rückrufbitte, keine Buchung", async () => {
    const { d, log } = deps({ quotaExceeded: async () => true });
    const calls = [
      { toolCallId: "1", tool: "freie_termine", args: { von: "2030-03-05", leistung: "PK" } },
      { toolCallId: "2", tool: "termin_buchen", args: { vorname: "Erika", nachname: "Muster", leistung: "PK", termin: "2030-03-05T08:00:00.000Z" } },
    ];
    const res = await runVoiceTools(calls, d);
    for (const r of res) expect(r.result).toMatch(/ruft .*zurück|später/);
    expect(log.slots).toBe(0);
    expect(log.book).toBe(0);
    expect(log.inbox.map((i) => i.subject)).toEqual([QUOTA_INBOX_SUBJECT, QUOTA_INBOX_SUBJECT]);
    expect(new Set(log.inbox.map((i) => i.body)).size).toBe(1); // gleicher Text → Posteingang entdoppelt je Anruf
    expect(log.outcomes).toEqual(["callback", "callback"]);
  });

  it("erschöpft: Rückrufbitte, Absagewunsch und Praxisinfo funktionieren weiter", async () => {
    const { d, log } = deps({ quotaExceeded: async () => true });
    const [cb, info] = await runVoiceTools(
      [
        { toolCallId: "1", tool: "rueckruf", args: { name: "Erika", anliegen: "Termin" } },
        { toolCallId: "2", tool: "praxis_info", args: {} },
      ],
      d,
    );
    expect(cb.result).toMatch(/weitergegeben/);
    expect(info.result).toMatch(/Testpraxis/);
    expect(log.inbox[0].subject).toBe("Rückrufbitte (KI-Telefon)");
  });

  it("erschöpft ohne Rufnummer: um Nummer bitten, keine Nachricht", async () => {
    const { d, log } = deps({ quotaExceeded: async () => true, caller: null });
    const [r] = await runVoiceTools([{ toolCallId: "1", tool: "freie_termine", args: { von: "2030-03-05", leistung: "PK" } }], d);
    expect(r.result).toMatch(/Rückrufnummer/);
    expect(log.inbox).toHaveLength(0);
  });

  it("nicht erschöpft: normale Verarbeitung", async () => {
    const { d, log } = deps({ quotaExceeded: async () => false });
    await runVoiceTools([{ toolCallId: "1", tool: "freie_termine", args: { von: "2030-03-05", leistung: "PK" } }], d);
    expect(log.slots).toBe(1);
  });
});

describe("Assistenten-Vorlagen", () => {
  const url = "https://crm.example.org/api/voice/retell?org=00000000-0000-4000-8000-000000000000";
  it("Retell: alle Werkzeuge als custom functions mit Server-URL, KI-Hinweis, kein Schlüssel", () => {
    const c = retellAgentConfig({ serverUrl: url, practiceName: 'Praxis "Fuß"' });
    const custom = c.llm.general_tools.filter((t) => t.type === "custom") as { name: string; url?: string }[];
    expect(custom.map((t) => t.name).sort()).toEqual([...VOICE_TOOLS].sort());
    expect(custom.every((t) => t.url === url)).toBe(true);
    expect(c.agent.webhook_url).toBe(url);
    expect(c.llm.begin_message).toMatch(/KI-Assistenten der Praxis Praxis Fuß/);
    expect(c.llm.general_prompt).toMatch(/KEINE MEDIZINISCHE BERATUNG/);
    expect(c.llm.general_prompt).toContain("{{current_time_Europe/Berlin}}");
    expect(JSON.stringify(c)).not.toMatch(/<SERVER_URL>|<PRAXISNAME>|<SERVER_SECRET>|key_/);
    expect(retellAgentConfig({ serverUrl: url, practiceName: "P", recordingNotice: true }).llm.begin_message).toMatch(/aufgezeichnet/);
  });

  it("Vapi: Platzhalter ersetzt", () => {
    const s = vapiAssistantConfig({ serverUrl: url.replace("retell", "vapi"), secret: "s3cr3t-s3cr3t-s3cr3t", practiceName: "Testpraxis" });
    expect(s).not.toMatch(/<SERVER_URL>|<SERVER_SECRET>|<PRAXISNAME>/);
    expect(JSON.parse(s).server.secret).toBe("s3cr3t-s3cr3t-s3cr3t");
  });
});
