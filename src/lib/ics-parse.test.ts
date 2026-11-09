/** iCal-Leser für das Kalender-Abo – Beispiel-Dateien wie aus Google Kalender, Docal.io, CalMedi (erfundene Daten). */
import { describe, expect, it } from "vitest";
import { eventKey, parseDuration, parseIcs, unescapeText, zonedToUtc } from "./ics-parse";

const W = { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2027-02-08T00:00:00Z") };
const ics = (...lines: string[]) => lines.join("\r\n") + "\r\n";

/** Gekürzter Export von Google Kalender (Privatadresse im iCal-Format) mit VTIMEZONE, Faltung und Escaping. */
const GOOGLE = ics(
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Doctolib Praxis",
  "X-WR-TIMEZONE:Europe/Berlin",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "X-LIC-LOCATION:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Berlin:20261110T093000",
  "DTEND;TZID=Europe/Berlin:20261110T101500",
  "DTSTAMP:20261101T120000Z",
  "UID:7kukuqrfedlm2f9t2eqmk9a4ou@google.com",
  "CREATED:20261101T110000Z",
  "DESCRIPTION:Gebucht über Doctolib\\nTelefon: 030 1234567\\, Neupatient\\; bitt",
  " e Anamnese",
  "LAST-MODIFIED:20261101T110000Z",
  "LOCATION:Praxis Mitte\\, Beispielstraße 1",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Erika Musterfrau - Podologische Komplexbehandlung",
  "TRANSP:OPAQUE",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Erinnerung",
  "TRIGGER:-P0DT0H10M0S",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261112T130000Z",
  "DTEND:20261112T134500Z",
  "UID:utc-event@google.com",
  "SUMMARY:[Doctolib] Max M. · Nagelkorrekturspange Kontrolle",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261124",
  "DTEND;VALUE=DATE:20261126",
  "UID:allday@google.com",
  "SUMMARY:Fortbildung",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Berlin:20261113T080000",
  "DTEND;TZID=Europe/Berlin:20261113T083000",
  "UID:cancelled@google.com",
  "STATUS:CANCELLED",
  "SUMMARY:Abgesagt: Termin Doctolib",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Berlin:20250105T100000",
  "DTEND;TZID=Europe/Berlin:20250105T110000",
  "UID:outside@google.com",
  "SUMMARY:alt",
  "END:VEVENT",
  "END:VCALENDAR",
);

describe("iCal-Leser: Google-Export", () => {
  const r = parseIcs(GOOGLE, W);
  const byUid = (uid: string) => r.events.find((e) => e.uid === uid)!;

  it("liest Kalendername und nur Termine im Fenster", () => {
    expect(r.calendarName).toBe("Doctolib Praxis");
    expect(r.events.map((e) => e.uid)).toEqual(["7kukuqrfedlm2f9t2eqmk9a4ou@google.com", "utc-event@google.com", "cancelled@google.com", "allday@google.com"]);
    expect(r.warnings).toEqual({ rruleSkipped: 0, invalid: 0, unknownTz: 0, truncated: 0 });
  });

  it("TZID Europe/Berlin (Winterzeit) → UTC, Faltung und Escaping, VALARM ignoriert", () => {
    const e = byUid("7kukuqrfedlm2f9t2eqmk9a4ou@google.com");
    expect(e.start.toISOString()).toBe("2026-11-10T08:30:00.000Z");
    expect(e.end.toISOString()).toBe("2026-11-10T09:15:00.000Z");
    expect(e.summary).toBe("Erika Musterfrau - Podologische Komplexbehandlung");
    expect(e.description).toBe("Gebucht über Doctolib\nTelefon: 030 1234567, Neupatient; bitte Anamnese");
    expect(e.location).toBe("Praxis Mitte, Beispielstraße 1");
    expect(e.status).toBe("CONFIRMED");
    expect(e.allDay).toBe(false);
    expect(e.recurrenceKey).toBeNull();
  });

  it("UTC-Zeiten (…Z) und Docal-/CalMedi-artige Titel unverändert", () => {
    const e = byUid("utc-event@google.com");
    expect(e.start.toISOString()).toBe("2026-11-12T13:00:00.000Z");
    expect(e.summary).toBe("[Doctolib] Max M. · Nagelkorrekturspange Kontrolle");
  });

  it("ganztägig: Berliner Mitternacht, DTEND exklusiv", () => {
    const e = byUid("allday@google.com");
    expect(e.allDay).toBe(true);
    expect(e.start.toISOString()).toBe("2026-11-23T23:00:00.000Z");
    expect(e.end.toISOString()).toBe("2026-11-25T23:00:00.000Z");
  });

  it("STATUS:CANCELLED bleibt erkennbar", () => {
    expect(byUid("cancelled@google.com").status).toBe("CANCELLED");
  });
});

describe("iCal-Leser: Zeitzonen", () => {
  it("Sommerzeit, Windows-Zonenname, Mozilla-Präfix, floating und unbekannte Zone", () => {
    const r = parseIcs(
      ics(
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT", "UID:a", "DTSTART;TZID=Europe/Berlin:20270615T090000", "DTEND;TZID=Europe/Berlin:20270615T093000", "END:VEVENT",
        "BEGIN:VEVENT", "UID:b", 'DTSTART;TZID="W. Europe Standard Time":20261201T090000', "DURATION:PT45M", "END:VEVENT",
        "BEGIN:VEVENT", "UID:c", "DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20261201T100000", "END:VEVENT",
        "BEGIN:VEVENT", "UID:d", "DTSTART:20261201T110000", "DTEND:20261201T113000", "END:VEVENT",
        "BEGIN:VEVENT", "UID:e", "DTSTART;TZID=Mars/Olympus:20261201T120000", "END:VEVENT",
        "END:VCALENDAR",
      ),
      { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2027-12-31T00:00:00Z") },
    );
    const at = (uid: string) => r.events.find((e) => e.uid === uid)!;
    expect(at("a").start.toISOString()).toBe("2027-06-15T07:00:00.000Z");
    expect(at("b").start.toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(at("b").end.toISOString()).toBe("2026-12-01T08:45:00.000Z");
    expect(at("c").start.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(at("d").start.toISOString()).toBe("2026-12-01T10:00:00.000Z"); // floating = Europe/Berlin
    expect(at("e").start.toISOString()).toBe("2026-12-01T11:00:00.000Z");
    expect(r.warnings.unknownTz).toBe(1);
  });

  it("zonedToUtc über die Zeitumstellung", () => {
    expect(zonedToUtc(2026, 10, 25, 1, 30, 0, "Europe/Berlin").toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(zonedToUtc(2026, 10, 25, 4, 0, 0, "Europe/Berlin").toISOString()).toBe("2026-10-25T03:00:00.000Z");
    expect(zonedToUtc(2027, 3, 28, 3, 0, 0, "Europe/Berlin").toISOString()).toBe("2027-03-28T01:00:00.000Z");
  });
});

describe("iCal-Leser: Serien", () => {
  it("wöchentlich mit EXDATE und geändertem Einzeltermin (RECURRENCE-ID), Ortszeit über die Zeitumstellung", () => {
    const r = parseIcs(
      ics(
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:serie@google.com",
        "DTSTART;TZID=Europe/Berlin:20261013T140000",
        "DTEND;TZID=Europe/Berlin:20261013T143000",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261208T225959Z",
        "EXDATE;TZID=Europe/Berlin:20261117T140000",
        "SUMMARY:Spangenkontrolle",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:serie@google.com",
        "RECURRENCE-ID;TZID=Europe/Berlin:20261124T140000",
        "DTSTART;TZID=Europe/Berlin:20261124T160000",
        "DTEND;TZID=Europe/Berlin:20261124T163000",
        "SUMMARY:Spangenkontrolle (verschoben)",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
      W,
    );
    expect(r.events.map((e) => [e.start.toISOString(), e.summary])).toEqual([
      ["2026-11-03T13:00:00.000Z", "Spangenkontrolle"],
      ["2026-11-10T13:00:00.000Z", "Spangenkontrolle"],
      ["2026-11-24T15:00:00.000Z", "Spangenkontrolle (verschoben)"],
      ["2026-12-01T13:00:00.000Z", "Spangenkontrolle"],
      ["2026-12-08T13:00:00.000Z", "Spangenkontrolle"],
    ]);
    // stabile Schlüssel je Vorkommen (Verschiebung behält den ursprünglichen Schlüssel)
    expect(eventKey(r.events[2])).toBe("serie@google.com#2026-11-24T13:00:00Z");
    expect(new Set(r.events.map(eventKey)).size).toBe(5);
  });

  it("COUNT zählt ab DTSTART (auch vor dem Fenster), INTERVAL, monatlich am 2. Dienstag, täglich", () => {
    const r = parseIcs(
      ics(
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT", "UID:count", "DTSTART:20261020T080000Z", "DTEND:20261020T083000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4", "END:VEVENT",
        "BEGIN:VEVENT", "UID:monthly", "DTSTART;TZID=Europe/Berlin:20261013T090000", "DTEND;TZID=Europe/Berlin:20261013T100000", "RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=4", "END:VEVENT",
        "BEGIN:VEVENT", "UID:daily", "DTSTART;TZID=Europe/Berlin:20261230T120000", "DTEND;TZID=Europe/Berlin:20261230T121500", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=4", "END:VEVENT",
        "END:VCALENDAR",
      ),
      W,
    );
    const starts = (uid: string) => r.events.filter((e) => e.uid === uid).map((e) => e.start.toISOString().slice(0, 10));
    expect(starts("count")).toEqual(["2026-11-03", "2026-11-17", "2026-12-01"]);
    expect(starts("monthly")).toEqual(["2026-11-10", "2026-12-08", "2027-01-12"]);
    expect(starts("daily")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-04"]);
  });

  it("nicht unterstützte Regeln werden übersprungen und gezählt; kaputte Einträge auch", () => {
    const r = parseIcs(
      ics(
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT", "UID:x", "DTSTART:20261110T080000Z", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1", "END:VEVENT",
        "BEGIN:VEVENT", "UID:y", "DTSTART:20261110T080000Z", "RRULE:FREQ=HOURLY", "END:VEVENT",
        "BEGIN:VEVENT", "DTSTART:20261110T080000Z", "SUMMARY:ohne UID", "END:VEVENT",
        "BEGIN:VEVENT", "UID:z", "DTSTART:2026-11-10", "END:VEVENT",
        "BEGIN:VEVENT", "UID:ok", "DTSTART:20261110T080000Z", "END:VEVENT",
        "END:VCALENDAR",
      ),
      W,
    );
    expect(r.events.map((e) => e.uid)).toEqual(["ok"]);
    expect(r.warnings.rruleSkipped).toBe(2);
    expect(r.warnings.invalid).toBe(2);
    expect(r.events[0].summary).toBe("(ohne Titel)");
  });

  it("Zeilenenden LF, BOM und Kleinbuchstaben werden toleriert", () => {
    const r = parseIcs("﻿BEGIN:VCALENDAR\nBEGIN:VEVENT\nuid:lf\ndtstart:20261110T080000Z\nsummary:Test\nEND:VEVENT\nEND:VCALENDAR\n", W);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].summary).toBe("Test");
  });
});

describe("Hilfen", () => {
  it("Dauer und Text", () => {
    expect(parseDuration("PT1H30M")).toBe(90 * 60_000);
    expect(parseDuration("P1D")).toBe(86400_000);
    expect(parseDuration("P1W")).toBe(7 * 86400_000);
    expect(parseDuration("X")).toBeNull();
    expect(unescapeText("a\\,b\\;c\\\\d\\Ne")).toBe("a,b;c\\d\ne");
  });
});
