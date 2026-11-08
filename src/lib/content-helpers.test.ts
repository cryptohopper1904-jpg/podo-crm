import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calendarToken, verifyCalendarToken } from "./calendar-token";
import { buildIcs, initials } from "./ical";
import { categorizeNews } from "./news-sources";
import { neutralReviewReply, reviewReplyProblems } from "./review-guard";
import { parseFeed } from "./rss";

describe("Bewertungsantworten (Schweigepflicht)", () => {
  it("lehnt Behandlungs- und Gesundheitsangaben ab", () => {
    expect(reviewReplyProblems("Schön, dass Ihre Nagelspange so gut sitzt!")).toContain("Befund/Leistung");
    expect(reviewReplyProblems("Danke, dass Sie zur Behandlung bei uns waren.")).toContain("Behandlung/Termin");
    expect(reviewReplyProblems("Wir freuen uns, Sie als langjährige Patientin zu haben.")).toContain("Bestätigung Patientenstatus");
    expect(reviewReplyProblems("Ihre Ärzte und Ihre Füße")).toEqual(expect.arrayContaining(["Verordnung/Kasse", "Körperbezug"]));
    expect(reviewReplyProblems("Gute Besserung bei Ihrer Diabetes-Erkrankung")).toEqual(expect.arrayContaining(["Gesundheitsangabe"]));
  });
  it("lässt neutrale Antworten zu", () => {
    expect(reviewReplyProblems(neutralReviewReply(5, "Podologie Beispiel"))).toEqual([]);
    expect(reviewReplyProblems(neutralReviewReply(2, "Podologie Beispiel"))).toEqual([]);
  });
});

describe("RSS/Atom", () => {
  it("parst RSS mit CDATA und Entities", () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Neue Heilmittel-Richtlinie]]></title><link>https://example.org/a</link><pubDate>Mon, 02 Mar 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Fu&amp;szlig;pflege &amp;amp; mehr&lt;/p&gt;</description></item></channel></rss>`;
    const [i] = parseFeed(xml);
    expect(i).toMatchObject({ title: "Neue Heilmittel-Richtlinie", url: "https://example.org/a", publishedAt: "2026-03-02T10:00:00.000Z" });
    expect(i.text).toContain("mehr");
  });
  it("parst Atom", () => {
    const xml = `<feed><entry><title>Kongress 2026</title><link rel="alternate" href="https://example.org/k"/><updated>2026-01-01T00:00:00Z</updated><summary>Programm</summary></entry></feed>`;
    expect(parseFeed(xml)).toEqual([{ title: "Kongress 2026", url: "https://example.org/k", publishedAt: "2026-01-01T00:00:00.000Z", text: "Programm" }]);
  });
  it("kategorisiert nach Schlagwörtern", () => {
    expect(categorizeNews("G-BA ändert die Heilmittel-Richtlinie")).toBe("Recht & Abrechnung");
    expect(categorizeNews("Webinar zur Nagelkorrektur")).toBe("Fortbildung");
    expect(categorizeNews("Neuer Autoklav vorgestellt")).toBe("Geräte");
    expect(categorizeNews("Wetter")).toBe("allgemein");
  });
});

describe("iCal-Feed", () => {
  it("Token prüfen", () => {
    const key = randomBytes(32);
    const uid = "11111111-2222-3333-4444-555555555555";
    const t = calendarToken(uid, key);
    expect(verifyCalendarToken(t, key)).toBe(uid);
    expect(verifyCalendarToken(`${t}.ics`, key)).toBe(uid);
    expect(verifyCalendarToken(t.slice(0, -2) + "xx", key)).toBeNull();
    expect(verifyCalendarToken(t, randomBytes(32))).toBeNull();
  });
  it("erzeugt ICS ohne Namen", () => {
    expect(initials("Erika", "Beispiel")).toBe("E. B.");
    const ics = buildIcs("Test", [{ uid: "a@x", start: new Date("2026-11-09T09:30:00Z"), end: new Date("2026-11-09T10:10:00Z"), summary: "E. B. · PK, NS" }], new Date("2026-11-07T00:00:00Z"));
    expect(ics).toContain("DTSTART:20261109T093000Z");
    expect(ics).toContain("SUMMARY:E. B. · PK\\, NS");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
