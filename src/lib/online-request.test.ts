import { describe, expect, it } from "vitest";
import { redact } from "@/integrations/llm/redact";
import { NOTE_REMOVED, SERVICE_REMOVED, onlineRequestAppointmentId, onlineRequestLlmText, onlineRequestNames, singleLine } from "./online-request";
import { aiReplyChannel, aiReplyDisclosure, aiReplySettings } from "./ai-replies";
import { avvAcceptedAtLeast, avvReacceptance, versionAtLeast } from "./legal";

const body = [
  "Online-Anfrage: Nagelkorrekturspange am 2031-05-06 um 09:30 Uhr.",
  "Name: Olga Testfrau",
  "Telefon: 0151 7654321 · E-Mail: olga@example.org",
  "Ausfallregelung bei der Buchung bestätigt; Datenschutzhinweise verlinkt (2031-05-01T10:00:00.000Z).",
  "Notiz: Diabetikerin, bitte Frau Kowalski",
  "Name: Kowalski anrufen",
  "Bitte Patient zuordnen (bestehend oder neu) und Termin bestätigen.",
].join("\n");

describe("Online-Anfrage für KI-Antwortvorschläge (AppSec M-1)", () => {
  it("baut den Text neu auf: nur Datum/Uhrzeit und Name, Leistung und Notiz ersetzt, Kontakt entfällt", () => {
    const names = onlineRequestNames(body, { onlineRequest: { firstName: "Olga", lastName: "Testfrau" } });
    expect(names).toEqual(["Olga Testfrau", "Testfrau", "Olga"]);
    const text = onlineRequestLlmText(body, names);
    expect(text).toBe(
      `Online-Terminanfrage: ${SERVICE_REMOVED} am 2031-05-06 um 09:30 Uhr.\nName: Olga Testfrau\n${NOTE_REMOVED}\nDie Anfrage ist noch unbestätigt; die Praxis meldet sich zur Bestätigung.`,
    );
    const { text: sent } = redact(text, { names });
    for (const s of ["Olga", "Testfrau", "Kowalski", "Diabetikerin", "Nagel", "0151", "olga@"]) expect(sent).not.toContain(s);
  });

  it("ohne Notiz kein Platzhalter; ältere Nachricht ohne meta: Name aus der zweiten Zeile (nicht aus der Notiz)", () => {
    const plain = body.split("\n").filter((l) => !l.startsWith("Notiz") && !l.startsWith("Name: Kowalski")).join("\n");
    expect(onlineRequestLlmText(plain, ["Olga Testfrau"])).not.toContain(NOTE_REMOVED);
    expect(onlineRequestNames(body, null)).toEqual(["Olga Testfrau", "Testfrau", "Olga"]);
    expect(onlineRequestNames("Online-Anfrage: X am 2031-05-06 um 09:30 Uhr.\nName: Hans Peter Altmann", null)).toEqual(["Hans Peter Altmann", "Altmann", "Hans Peter", "Hans", "Peter"]);
    // unbekanntes Format: kein Name, trotzdem keine freien Angaben
    expect(onlineRequestLlmText("irgendwas mit Diagnose", [])).toBe(`Online-Terminanfrage: ${SERVICE_REMOVED}.\nDie Anfrage ist noch unbestätigt; die Praxis meldet sich zur Bestätigung.`);
  });

  it("Kennzeichen und Namen in einer Zeile", () => {
    expect(onlineRequestAppointmentId("online-request:7A0C1F5E-2F4B-4C1E-9D3A-6B2A1C0D9E8F")).toBe("7a0c1f5e-2f4b-4c1e-9d3a-6b2a1c0d9e8f");
    expect(onlineRequestAppointmentId("online-request:kaputt")).toBeNull();
    expect(onlineRequestAppointmentId("waitlist:1")).toBeNull();
    expect(singleLine(" Olga\nNotiz:\tX ")).toBe("Olga Notiz: X");
  });
});

describe("Schalter KI-Antwortvorschläge (Recht H-88-4)", () => {
  it("Standard aus; an nur mit Anbieter, Land und beiden Bestätigungen", () => {
    expect(aiReplySettings({}).enabled).toBe(false);
    const full = { enabled: true, provider: "Mistral AI", country: "Frankreich", avvConfirmed: true, confidentialityConfirmed: true };
    expect(aiReplySettings({ aiReplies: full }).enabled).toBe(true);
    expect(aiReplyDisclosure({ aiReplies: full })).toEqual({ provider: "Mistral AI", country: "Frankreich" });
    for (const k of ["provider", "country", "avvConfirmed", "confidentialityConfirmed"] as const) {
      expect(aiReplySettings({ aiReplies: { ...full, [k]: k.endsWith("Confirmed") ? "true" : " " } }).enabled, k).toBe(false);
    }
    expect(aiReplyDisclosure({ aiReplies: { ...full, enabled: false } })).toBeNull();
    expect(["email", "sms", "whatsapp", "kim"].every(aiReplyChannel)).toBe(true);
    expect(["phone", "none", "letter"].some(aiReplyChannel)).toBe(false);
  });
});

describe("AVV-Zustimmung", () => {
  it("vergleicht Versionen numerisch je Stelle", () => {
    expect(versionAtLeast("0.3", "0.3")).toBe(true);
    expect(versionAtLeast("0.10", "0.3")).toBe(true);
    expect(versionAtLeast("1", "0.3")).toBe(true);
    expect(versionAtLeast("0.2", "0.3")).toBe(false);
    expect(versionAtLeast(undefined, "0.3")).toBe(false);
    expect(versionAtLeast("0.3-beta", "0.3")).toBe(false);
    expect(avvAcceptedAtLeast({ legalAcceptance: { agb: "0.3", avv: "0.3" } }, "0.3")).toBe(true);
    expect(avvAcceptedAtLeast({}, "0.3")).toBe(false);
  });

  it("nachträgliche Zustimmung behält den AGB-Stand und die frühere Zustimmung", () => {
    const now = new Date("2026-11-14T10:00:00Z");
    const r = avvReacceptance({ agb: "0.3", avv: "0.2", version: "agb-0.3+avv-0.2", at: "2026-01-01T00:00:00Z", by: "a" }, "b", now);
    expect(r).toEqual({ agb: "0.3", avv: "0.3", version: "agb-0.3+avv-0.3", at: now.toISOString(), by: "b", previous: { agb: "0.3", avv: "0.2", at: "2026-01-01T00:00:00Z", by: "a" } });
    expect(avvReacceptance(null, "b", now)).toEqual({ agb: null, avv: "0.3", version: "agb-?+avv-0.3", at: now.toISOString(), by: "b" });
  });
});
