import { describe, expect, it } from "vitest";
import { redact } from "@/integrations/llm/redact";
import {
  NOTE_REMOVED,
  ONLINE_REQUEST_SUBJECT,
  SERVICE_REMOVED,
  onlineRequestAppointmentId,
  onlineRequestLlmText,
  onlineRequestMessageAppointmentId,
  onlineRequestNames,
  singleLine,
} from "./online-request";
import { aiReplyChannel, aiReplyDisclosure, aiReplySettings } from "./ai-replies";
import { AVV_READONLY_NOTE, avvAcceptedAtLeast, avvBannerNews, avvReacceptance, RETENTION_MIN_AVV, versionAtLeast } from "./legal";

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

  it("AppSec I-4: Online-Anfrage nur bei eingehender Nachricht mit Kennzeichen, ohne external_id und mit festem Betreff", () => {
    const id = "7a0c1f5e-2f4b-4c1e-9d3a-6b2a1c0d9e8f";
    const m = { direction: "inbound", threadKey: `online-request:${id}`, externalId: null, subject: ONLINE_REQUEST_SUBJECT };
    expect(onlineRequestMessageAppointmentId(m)).toBe(id);
    expect(onlineRequestMessageAppointmentId({ ...m, externalId: "wamid.1" })).toBeNull();
    expect(onlineRequestMessageAppointmentId({ ...m, subject: "Re: Termin" })).toBeNull();
    expect(onlineRequestMessageAppointmentId({ ...m, subject: null })).toBeNull();
    expect(onlineRequestMessageAppointmentId({ ...m, direction: "outbound" })).toBeNull();
    expect(onlineRequestMessageAppointmentId({ ...m, threadKey: "online-request:kaputt" })).toBeNull();
  });
});

describe("Schalter KI-Antwortvorschläge (Recht H-88-4, M-88-6, L-2)", () => {
  it("Standard aus; an nur mit Anbieter, Land aus der Liste und beiden Bestätigungen", () => {
    expect(aiReplySettings({}).enabled).toBe(false);
    const full = { enabled: true, provider: "Mistral AI", country: "Frankreich", avvConfirmed: true, confidentialityConfirmed: true };
    expect(aiReplySettings({ aiReplies: full }).enabled).toBe(true);
    expect(aiReplyDisclosure({ aiReplies: full })).toEqual({ provider: "Mistral AI", country: "Frankreich", countryIn: "in Frankreich", thirdCountry: false });
    for (const k of ["provider", "country", "avvConfirmed", "confidentialityConfirmed"] as const) {
      expect(aiReplySettings({ aiReplies: { ...full, [k]: k.endsWith("Confirmed") ? "true" : " " } }).enabled, k).toBe(false);
    }
    // Land nicht aus der Liste (z. B. alter Freitext) → aus
    expect(aiReplySettings({ aiReplies: { ...full, country: "France" } }).enabled).toBe(false);
    expect(aiReplyDisclosure({ aiReplies: { ...full, enabled: false } })).toBeNull();
  });

  it("Drittland nur mit Bestätigung der Garantien; Ortsangabe mit Artikel", () => {
    const usa = { enabled: true, provider: "X", country: "USA", avvConfirmed: true, confidentialityConfirmed: true };
    expect(aiReplySettings({ aiReplies: usa })).toMatchObject({ enabled: false, thirdCountry: true });
    expect(aiReplyDisclosure({ aiReplies: { ...usa, transferConfirmed: true } })).toEqual({ provider: "X", country: "USA", countryIn: "in den USA", thirdCountry: true });
    expect(aiReplyDisclosure({ aiReplies: { ...usa, country: "Schweiz", transferConfirmed: true } })?.countryIn).toBe("in der Schweiz");
    expect(aiReplyDisclosure({ aiReplies: { ...usa, country: "Niederlande" } })).toMatchObject({ countryIn: "in den Niederlanden", thirdCountry: false });
  });

  it("KIM nie an den KI-Dienst (L-2); nur E-Mail, SMS, WhatsApp", () => {
    expect(["email", "sms", "whatsapp"].every(aiReplyChannel)).toBe(true);
    expect(["kim", "phone", "none", "letter"].some(aiReplyChannel)).toBe(false);
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
    // Löschlauf: eine gemeinsame Mindestversion, unabhängig von der aktuellen AVV-Version
    expect(RETENTION_MIN_AVV).toBe("0.3");
    expect(avvAcceptedAtLeast({ legalAcceptance: { avv: "0.4" } }, RETENTION_MIN_AVV)).toBe(true);
    expect(avvAcceptedAtLeast({ legalAcceptance: { avv: "0.2" } }, RETENTION_MIN_AVV)).toBe(false);
  });

  it("nachträgliche Zustimmung behält den AGB-Stand und die frühere Zustimmung", () => {
    const now = new Date("2026-11-14T10:00:00Z");
    const r = avvReacceptance({ agb: "0.3", avv: "0.2", version: "agb-0.3+avv-0.2", at: "2026-01-01T00:00:00Z", by: "a" }, "b", now);
    expect(r).toEqual({ agb: "0.3", avv: "0.4", version: "agb-0.3+avv-0.4", at: now.toISOString(), by: "b", previous: { agb: "0.3", avv: "0.2", at: "2026-01-01T00:00:00Z", by: "a" } });
    expect(avvReacceptance(null, "b", now)).toEqual({ agb: null, avv: "0.4", version: "agb-?+avv-0.4", at: now.toISOString(), by: "b" });
  });
});

describe("AVV-Banner: Neuerungen je bisheriger Version (Recht R-1)", () => {
  it("Zustimmung 0.3: Hinweis auf Nur-Lesen-Modus und Löschung nach Vertragsende, ohne Online-Anfragen-Hinweis", () => {
    expect(avvBannerNews("0.3")).toEqual({
      retention: false,
      readonly:
        "Neu ist u. a.: Nach Vertragsende bleiben deine Daten höchstens 12 Monate im Nur-Lesen-Modus lesbar und exportierbar und werden nach Ankündigung (mindestens 30 Tage vorher) gelöscht (§ 10 Nr. 2).",
    });
  });
  it("ältere Zustimmung: beide Hinweise; ab 0.4 keiner", () => {
    expect(avvBannerNews("0.2")).toEqual({ retention: true, readonly: `Außerdem neu: ${AVV_READONLY_NOTE}` });
    expect(avvBannerNews(null).retention).toBe(true);
    expect(avvBannerNews("0.4")).toEqual({ retention: false, readonly: null });
    expect(avvBannerNews("0.10")).toEqual({ retention: false, readonly: null });
  });
});
