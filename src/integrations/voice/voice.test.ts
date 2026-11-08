/** KI-Telefonagent: Vapi-Adapter (Signatur fail closed, Parser, Antwortformat), Werkzeug-Kern, Assistenten-Vorlage. */
import { describe, expect, it, vi } from "vitest";
import assistant from "./vapi-assistant.json";
import {
  maskPhone,
  recordingAnnounced,
  runVoiceTools,
  shortName,
  shouldStoreTranscript,
  strongerOutcome,
  toolArgs,
  VOICE_TOOLS,
  type VoiceToolDeps,
} from "./core";
import { parseVapiEvent, VapiVoiceAgent } from "./vapi";
import { voiceAgentFor } from "./voice-agent";

const NOW = new Date("2030-03-04T07:00:00Z"); // Montag

function fakeDeps(over: Partial<VoiceToolDeps> = {}) {
  const calls = { book: [] as unknown[], inbox: [] as { subject: string; body: string; from: string | null }[], outcomes: [] as string[], findSlots: [] as unknown[] };
  const deps: VoiceToolDeps = {
    now: () => NOW,
    caller: "+4915100000023",
    services: async () => [{ code: "PK", name: "Podologische Komplexbehandlung", durationMin: 40 }],
    findSlots: async (i) => {
      calls.findSlots.push(i);
      return Array.from({ length: 6 }, (_, k) => new Date(Date.parse("2030-03-05T08:00:00Z") + k * 3600_000)).slice(0, i.limit);
    },
    book: async (i) => {
      calls.book.push(i);
      return { status: "booked", appointmentId: "a1" };
    },
    inbox: async (i) => {
      calls.inbox.push(i);
    },
    practiceInfo: async () => ({ name: "Testpraxis", address: "Musterweg 1, 10115 Berlin", phone: "030 000000", openingText: "Mo–Fr 08:00 bis 18:00 Uhr" }),
    noteOutcome: async (o) => {
      calls.outcomes.push(o);
    },
    ...over,
  };
  return { deps, calls };
}

const one = async (tool: string, args: Record<string, unknown>, deps: VoiceToolDeps) => (await runVoiceTools([{ toolCallId: "t1", tool, args }], deps))[0].result;

describe("Vapi-Adapter", () => {
  const port = new VapiVoiceAgent();

  it("Signaturprüfung ist fail closed", () => {
    expect(port.verify({ "x-vapi-secret": "abc" }, {})).toBe(false); // kein Geheimnis hinterlegt
    expect(port.verify({ "x-vapi-secret": "" }, { webhookToken: "" })).toBe(false);
    expect(port.verify({}, { webhookToken: "geheim-123" })).toBe(false); // Header fehlt
    expect(port.verify({ "x-vapi-secret": "geheim-124" }, { webhookToken: "geheim-123" })).toBe(false);
    expect(port.verify({ "x-vapi-secret": "geheim-123 " }, { webhookToken: "geheim-123" })).toBe(false);
    expect(port.verify({ "x-vapi-secret": "geheim-123" }, { webhookToken: "geheim-123" })).toBe(true);
    // eigenes Secret hat Vorrang vor dem Token
    expect(port.verify({ "x-vapi-secret": "geheim-123" }, { webhookToken: "geheim-123", vapiSecret: "anders" })).toBe(false);
    expect(port.verify({ "x-vapi-secret": "anders" }, { webhookToken: "geheim-123", vapiSecret: "anders" })).toBe(true);
  });

  it("parst tool-calls (Argumente als String oder Objekt) und begrenzt die Anzahl", () => {
    const ev = parseVapiEvent({
      message: {
        type: "tool-calls",
        call: { id: "call-1", customer: { number: "+4915112345623" } },
        toolCallList: [
          { id: "tc1", type: "function", function: { name: "freie_termine", arguments: '{"von":"2030-03-05","leistung":"PK"}' } },
          { id: "tc2", type: "function", function: { name: "praxis_info", arguments: {} } },
          ...Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, function: { name: "praxis_info", arguments: "kaputt{" } })),
        ],
      },
    });
    expect(ev.type).toBe("tool_calls");
    if (ev.type !== "tool_calls") return;
    expect(ev.callId).toBe("call-1");
    expect(ev.from).toBe("+4915112345623");
    expect(ev.calls).toHaveLength(5);
    expect(ev.calls[0]).toEqual({ toolCallId: "tc1", tool: "freie_termine", args: { von: "2030-03-05", leistung: "PK" } });
    expect(ev.calls[4].args).toEqual({});
  });

  it("parst end-of-call-report und status-update, Unbekanntes bleibt unknown", () => {
    const end = parseVapiEvent({
      message: { type: "end-of-call-report", call: { id: "c" }, endedReason: "customer-ended-call", startedAt: "2030-03-04T07:00:00Z", endedAt: "2030-03-04T07:02:05Z", analysis: { summary: "Termin gewünscht." }, artifact: { transcript: "AI: Hallo" } },
    });
    expect(end).toMatchObject({ type: "call_ended", callId: "c", durationSec: 125, summary: "Termin gewünscht.", transcript: "AI: Hallo", endedReason: "customer-ended-call" });
    expect(parseVapiEvent({ message: { type: "status-update", call: { id: "c" }, status: "in-progress" } })).toMatchObject({ type: "status", status: "in-progress" });
    expect(parseVapiEvent({ message: { type: "tool-calls" } }).type).toBe("unknown"); // ohne Call-ID
    expect(parseVapiEvent(null).type).toBe("unknown");
    expect(parseVapiEvent({ message: { type: "transcript" } }).type).toBe("unknown");
  });

  it("antwortet im Vapi-Format { results: [{ toolCallId, result }] }", () => {
    expect(port.formatToolResults([{ toolCallId: "tc1", result: "ok" }])).toEqual({ results: [{ toolCallId: "tc1", result: "ok" }] });
  });

  it("nicht umgesetzte Anbieter werden abgelehnt", () => {
    expect(voiceAgentFor("vapi")).toBeInstanceOf(VapiVoiceAgent);
    expect(() => voiceAgentFor("fonio")).toThrow(/noch nicht umgesetzt/);
    expect(() => voiceAgentFor("evil")).toThrow();
  });
});

describe("Werkzeuge (anbieterneutral)", () => {
  it("freie_termine: höchstens 3 Vorschläge, keine Patientendaten, Zeitraum begrenzt", async () => {
    const { deps, calls } = fakeDeps();
    const r = await one("freie_termine", { von: "2030-03-05", bis: "2030-12-31", leistung: "pk" }, deps);
    expect(r.match(/termin=/g)).toHaveLength(3);
    expect(r).toContain("Dienstag, 05.03.2030 um 09:00 Uhr");
    expect(r).toContain("termin=2030-03-05T08:00:00.000Z");
    expect(calls.findSlots[0]).toMatchObject({ fromIso: "2030-03-05", toIso: "2030-03-18", durationMin: 40, limit: 3 });
    expect(r).not.toMatch(/Musterfrau|Patient|Kunde/);
  });

  it("freie_termine: Vergangenheit wird auf heute gezogen, unbekannte Leistung nennt Alternativen", async () => {
    const { deps, calls } = fakeDeps();
    await one("freie_termine", { von: "2020-01-01", leistung: "PK" }, deps);
    expect(calls.findSlots[0]).toMatchObject({ fromIso: "2030-03-04", toIso: "2030-03-04" });
    expect(await one("freie_termine", { von: "2030-03-05", leistung: "XX" }, deps)).toMatch(/Möglich sind: PK/);
    expect(await one("freie_termine", { leistung: "PK" }, deps)).toMatch(/ungültig/);
  });

  it("termin_buchen: übergibt validierte Daten, Rufnummer des Anrufers als Fallback", async () => {
    const { deps, calls } = fakeDeps();
    const r = await one("termin_buchen", { vorname: "Erika", nachname: "Musterfrau", leistung: "PK", termin: "2030-03-05T08:00:00.000Z" }, deps);
    expect(r).toMatch(/vorgemerkt/);
    expect(r).toMatch(/erst gültig, wenn die Praxis ihn bestätigt/);
    expect(calls.book[0]).toMatchObject({ firstName: "Erika", lastName: "Musterfrau", phone: "+4915100000023", startsAt: new Date("2030-03-05T08:00:00.000Z") });
    expect(calls.outcomes).toContain("booked");
  });

  it("termin_buchen: zu früh, ungültig, belegt oder doppelt → keine Buchung bzw. klare Antwort", async () => {
    const { deps, calls } = fakeDeps();
    expect(await one("termin_buchen", { vorname: "E", nachname: "M", leistung: "PK", termin: "2030-03-04T07:30:00Z" }, deps)).toMatch(/nicht mehr buchbar/);
    expect(await one("termin_buchen", { vorname: "E", leistung: "PK", termin: "2030-03-05T08:00:00Z" }, deps)).toMatch(/ungültig/);
    expect(await one("termin_buchen", { vorname: "E", nachname: "M", leistung: "PK", termin: "morgen" }, deps)).toMatch(/ungültig/);
    expect(calls.book).toHaveLength(0);
    const taken = fakeDeps({ book: async () => ({ status: "taken" }) });
    expect(await one("termin_buchen", { vorname: "E", nachname: "M", leistung: "PK", termin: "2030-03-05T08:00:00Z" }, taken.deps)).toMatch(/nicht mehr frei/);
    const noPhone = fakeDeps({ caller: null });
    expect(await one("termin_buchen", { vorname: "E", nachname: "M", leistung: "PK", termin: "2030-03-05T08:00:00Z" }, noPhone.deps)).toMatch(/Rückrufnummer/);
  });

  it("termin_absagen: nur Posteingang „Absagewunsch“, keine Buchungsänderung, kein Orakel", async () => {
    const { deps, calls } = fakeDeps();
    const r = await one("termin_absagen", { datum: "2030-03-06" }, deps);
    expect(calls.book).toHaveLength(0);
    expect(calls.inbox).toHaveLength(1);
    expect(calls.inbox[0].subject).toMatch(/^Absagewunsch/);
    expect(calls.inbox[0].body).toMatch(/nichts automatisch geändert/);
    expect(r).not.toMatch(/kein Termin|nicht gefunden|gefunden/i);
  });

  it("rueckruf und praxis_info", async () => {
    const { deps, calls } = fakeDeps();
    await one("rueckruf", { name: "Erika", anliegen: "Rötung am Fuß", dringend: true }, deps);
    expect(calls.inbox[0].subject).toMatch(/^DRINGEND/);
    const info = await one("praxis_info", {}, deps);
    expect(info).toMatch(/Öffnungszeiten: Mo–Fr/);
    expect(info).toMatch(/Musterweg 1/);
  });

  it("unbekannte Werkzeuge und Fehler geben keine Details preis", async () => {
    const onError = vi.fn();
    const { deps } = fakeDeps({ findSlots: async () => { throw new Error("DB kaputt: password=xyz"); } });
    const r = await runVoiceTools([{ toolCallId: "a", tool: "drop_table", args: {} }, { toolCallId: "b", tool: "freie_termine", args: { von: "2030-03-05", leistung: "PK" } }], deps, onError);
    expect(r[0].result).toMatch(/gibt es nicht/);
    expect(r[1].result).toMatch(/Technischer Fehler/);
    expect(r[1].result).not.toMatch(/password|DB/);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("Hilfen", () => {
  it("maskiert Telefonnummern und kürzt Namen", () => {
    expect(maskPhone("+49 151 12345623")).toBe("+49 151 ••• 23");
    expect(maskPhone("030 1234567")).toBe("0301 ••• 67");
    expect(maskPhone("123")).toBe("•••");
    expect(maskPhone(null)).toBeNull();
    expect(shortName("Erika", "musterfrau")).toBe("Erika M.");
  });

  it("Transkript nur mit Einstellung UND angesagter Aufzeichnung", () => {
    const withNotice = `AI: ${assistant.firstMessageMitAufzeichnung}\nUser: Hallo`;
    const without = `AI: ${assistant.assistant.firstMessage}\nUser: Hallo`;
    expect(recordingAnnounced(withNotice)).toBe(true);
    expect(recordingAnnounced(without)).toBe(false);
    expect(recordingAnnounced("User: das wird aufgezeichnet?\nAI: Sie sprechen mit dem KI-Assistenten")).toBe(false);
    expect(shouldStoreTranscript({ storeTranscripts: true, serviceCodes: [] }, withNotice)).toBe(true);
    expect(shouldStoreTranscript({ storeTranscripts: false, serviceCodes: [] }, withNotice)).toBe(false);
    expect(shouldStoreTranscript({ storeTranscripts: true, serviceCodes: [] }, without)).toBe(false);
  });

  it("stärkerer Ausgang gewinnt", () => {
    expect(strongerOutcome("info", "booked")).toBe("booked");
    expect(strongerOutcome("booked", "info")).toBe("booked");
    expect(strongerOutcome(null, null)).toBeNull();
  });
});

describe("Assistenten-Vorlage vapi-assistant.json", () => {
  const sys = assistant.assistant.model.messages.find((m) => m.role === "system")!.content;

  it("beginnt mit dem KI-Hinweis (AI Act Art. 50)", () => {
    expect(assistant.assistant.firstMessage.startsWith("Sie sprechen mit dem KI-Assistenten der Praxis")).toBe(true);
    expect(assistant.firstMessageMitAufzeichnung.startsWith("Sie sprechen mit dem KI-Assistenten der Praxis")).toBe(true);
    expect(sys.startsWith("Sie sprechen mit dem KI-Assistenten der Praxis")).toBe(true);
  });

  it("verbietet medizinische Beratung und regelt Notfälle (Wunde, Fieber, diabetischer Fuß mit Rötung → Arzt/112, Rückruf)", () => {
    expect(sys).toMatch(/KEINE MEDIZINISCHE BERATUNG/);
    expect(sys).toMatch(/niemals medizinische Ratschläge/);
    for (const w of ["Wunde", "Fieber", "Diabetes", "Rötung", "112", "116 117", "Hausarzt", "dringend = true"]) expect(sys).toContain(w);
  });

  it("liest nie Patientendaten vor", () => {
    expect(sys).toMatch(/niemals Patientendaten vor/);
    expect(sys).toMatch(/bestätigen Sie nie, ob jemand Patient/);
  });

  it("Werkzeuge der Vorlage = Werkzeuge des Servers, Pflichtfelder passen zum Schema", () => {
    const tools = assistant.assistant.model.tools.map((t) => t.function);
    expect(tools.map((t) => t.name).sort()).toEqual([...VOICE_TOOLS].sort());
    for (const t of tools) {
      const schema = toolArgs[t.name as keyof typeof toolArgs];
      const keys = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
      expect(Object.keys(t.parameters.properties).sort(), t.name).toEqual(keys.sort());
      for (const r of (t.parameters as { required?: string[] }).required ?? []) expect(keys).toContain(r);
    }
    for (const t of assistant.assistant.model.tools) expect(t.server.secret).toBe("<SERVER_SECRET>");
    expect(assistant.assistant.server.secret).toBe("<SERVER_SECRET>");
    expect(assistant.assistant.serverMessages).toEqual(expect.arrayContaining(["tool-calls", "end-of-call-report"]));
  });
});
