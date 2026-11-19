import { describe, expect, it } from "vitest";
import {
  addMonthsUtc,
  art14Text,
  ART14_DRAFT_MARK,
  checkRetrievedDate,
  deleteAfterFor,
  deleteMonthsOf,
  isConsentKind,
  NO_CONSENT_CONTACT_HINT,
  originLabel,
  phoneVisible,
} from "./dsgvo";

describe("Löschfrist", () => {
  it("Anlage + n Monate in UTC, Monatsende gekappt", () => {
    expect(addMonthsUtc(new Date("2026-08-31T10:00:00Z"), 6).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonthsUtc(new Date("2027-08-31T10:00:00Z"), 6).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(deleteAfterFor(new Date("2026-11-15T10:00:00Z"), 12).toISOString()).toBe("2027-11-15T10:00:00.000Z");
  });

  it("nur 6 bis 24 ganze Monate", () => {
    const c = new Date("2026-11-15T10:00:00Z");
    expect(() => deleteAfterFor(c, 5)).toThrow(/Löschfrist/);
    expect(() => deleteAfterFor(c, 25)).toThrow(/Löschfrist/);
    expect(() => deleteAfterFor(c, 12.5)).toThrow(/Löschfrist/);
    expect(deleteMonthsOf(c, deleteAfterFor(c, 18))).toBe(18);
    expect(deleteMonthsOf(c, new Date("2027-01-01T00:00:00Z"))).toBeNull();
  });
});

describe("Herkunft", () => {
  const now = new Date("2026-11-19T23:30:00Z"); // in Berlin schon der 20.11.
  it("Abrufdatum gültig, nicht in der Zukunft (deutsche Zeit)", () => {
    expect(checkRetrievedDate("2026-11-20", now)).toEqual({ ok: true, date: "2026-11-20" });
    expect(checkRetrievedDate("2026-11-21", now)).toMatchObject({ ok: false, error: expect.stringMatching(/Zukunft/) });
    expect(checkRetrievedDate("2026-02-30", now)).toMatchObject({ ok: false, error: expect.stringMatching(/ungültig/) });
    expect(checkRetrievedDate("", now)).toMatchObject({ ok: false, error: expect.stringMatching(/Abrufdatum/) });
    expect(checkRetrievedDate("1999-12-31", now)).toMatchObject({ ok: false });
  });

  it("Anzeige mit lesbarer Quelle und Hinweis bei fehlenden Angaben", () => {
    expect(originLabel("osm", "2026-11-03")).toBe("OpenStreetMap · abgerufen 03.11.2026");
    expect(originLabel("Messe Test", null)).toBe("Messe Test · Abrufdatum fehlt");
    expect(originLabel(null, null)).toBe("Quelle fehlt · Abrufdatum fehlt");
  });
});

describe("Einwilligung und Telefonnummer", () => {
  it("Telefonnummer nur mit Einwilligung oder bei Bestandskunden", () => {
    expect(phoneVisible({ consentAt: null, status: "neu" })).toBe(false);
    expect(phoneVisible({ consentAt: null, status: "interessiert" })).toBe(false);
    expect(phoneVisible({ consentAt: new Date(), status: "neu" })).toBe(true);
    expect(phoneVisible({ consentAt: null, status: "kunde" })).toBe(true);
    expect(phoneVisible({ consentAt: null, status: "neu", stage: "kunde" })).toBe(true);
  });

  it("Art der Einwilligung nur aus der Liste; Hinweistext wörtlich", () => {
    expect(isConsentKind("persoenlich")).toBe(true);
    expect(isConsentKind("fax")).toBe(false);
    expect(NO_CONSENT_CONTACT_HINT).toBe("Werbe-E-Mails und Werbeanrufe nur mit Einwilligung (§ 7 UWG). Kaltanrufe nicht erlaubt.");
  });
});

describe("Datenschutzhinweis nach Art. 14 DSGVO", () => {
  it("Entwurf mit Pflichtinhalten und Platzhalter {{Firma}}", () => {
    const t = art14Text();
    expect(t.startsWith(ART14_DRAFT_MARK)).toBe(true);
    expect(ART14_DRAFT_MARK).toBe("ENTWURF – vor Verwendung rechtlich prüfen lassen");
    for (const part of ["{{Firma}}", "Art. 6 Abs. 1 lit. f DSGVO", "OpenStreetMap", "Impressum", "Speicherdauer", "Art. 21", "Auskunft (Art. 15 DSGVO)", "{{Abrufdatum}}", "{{Löschdatum}}"]) {
      expect(t).toContain(part);
    }
  });

  it("setzt Quelle, Abrufdatum und Löschdatum ein, {{Firma}} bleibt", () => {
    const t = art14Text({ quelle: "OpenStreetMap", abrufdatum: "03.11.2026", loeschdatum: "03.11.2027" });
    expect(t).toContain("Quellen: OpenStreetMap, abgerufen am 03.11.2026.");
    expect(t).toContain("bis zum 03.11.2027");
    expect(t).toContain("{{Firma}}");
    expect(t).not.toContain("{{Abrufdatum}}");
  });
});
