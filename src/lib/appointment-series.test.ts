import { describe, expect, it } from "vitest";
import { seriesStarts } from "./appointment-series";
import { berlinDateIso, timeDe } from "./format";

/** Berliner Datum + Uhrzeit eines UTC-Zeitpunkts */
const berlin = (d: Date) => `${berlinDateIso(d)} ${timeDe(d)}`;

describe("seriesStarts – Serientermine über Zeitumstellungen", () => {
  it("Umstellung auf Sommerzeit (29.03.2026): 12:00 bleibt 12:00", () => {
    const s = seriesStarts("2026-03-15", "12:00", 1, 4);
    expect(s.map(berlin)).toEqual(["2026-03-15 12:00", "2026-03-22 12:00", "2026-03-29 12:00", "2026-04-05 12:00"]);
    // MEZ = UTC+1, MESZ = UTC+2
    expect(s.map((d) => d.toISOString())).toEqual(["2026-03-15T11:00:00.000Z", "2026-03-22T11:00:00.000Z", "2026-03-29T10:00:00.000Z", "2026-04-05T10:00:00.000Z"]);
  });

  it("Umstellung auf Winterzeit (25.10.2026): 12:00 bleibt 12:00", () => {
    const s = seriesStarts("2026-10-11", "12:00", 1, 4);
    expect(s.map(berlin)).toEqual(["2026-10-11 12:00", "2026-10-18 12:00", "2026-10-25 12:00", "2026-11-01 12:00"]);
    expect(s.map((d) => d.toISOString())).toEqual(["2026-10-11T10:00:00.000Z", "2026-10-18T10:00:00.000Z", "2026-10-25T11:00:00.000Z", "2026-11-01T11:00:00.000Z"]);
  });

  it("Werktags-Serie über die Umstellungswoche (Mo 23.03. → Mo 30.03.)", () => {
    expect(seriesStarts("2026-03-23", "08:15", 1, 2).map(berlin)).toEqual(["2026-03-23 08:15", "2026-03-30 08:15"]);
    expect(seriesStarts("2026-10-19", "17:45", 1, 2).map(berlin)).toEqual(["2026-10-19 17:45", "2026-10-26 17:45"]);
  });

  it("mehrwöchiges Intervall über beide Umstellungen eines Jahres", () => {
    const s = seriesStarts("2026-02-26", "12:00", 4, 12); // 11 × 28 Tage → 31.12.
    expect(s).toHaveLength(12);
    for (const d of s) expect(timeDe(d)).toBe("12:00");
    expect(berlinDateIso(s[11])).toBe("2026-12-31");
  });

  it("Monats- und Jahresgrenzen", () => {
    expect(seriesStarts("2026-01-26", "09:30", 1, 2).map(berlin)).toEqual(["2026-01-26 09:30", "2026-02-02 09:30"]);
    expect(seriesStarts("2026-04-28", "09:30", 2, 2).map(berlin)).toEqual(["2026-04-28 09:30", "2026-05-12 09:30"]);
    expect(seriesStarts("2026-12-22", "10:00", 1, 3).map(berlin)).toEqual(["2026-12-22 10:00", "2026-12-29 10:00", "2027-01-05 10:00"]);
  });

  it("Schaltjahr: 29.02. wird mitgezählt, Nicht-Schaltjahr nicht", () => {
    expect(seriesStarts("2028-02-22", "12:00", 1, 3).map(berlinDateIso)).toEqual(["2028-02-22", "2028-02-29", "2028-03-07"]);
    expect(seriesStarts("2027-02-22", "12:00", 1, 2).map(berlinDateIso)).toEqual(["2027-02-22", "2027-03-01"]);
    // Schaltjahr + Umstellung auf Sommerzeit (26.03.2028)
    expect(seriesStarts("2028-02-27", "12:00", 2, 3).map(berlin)).toEqual(["2028-02-27 12:00", "2028-03-12 12:00", "2028-03-26 12:00"]);
  });

  it("ohne Intervall genau ein Termin – unabhängig von der Anzahl", () => {
    expect(seriesStarts("2026-03-29", "12:00", 0, 5).map(berlin)).toEqual(["2026-03-29 12:00"]);
    expect(seriesStarts("2026-03-29", "12:00", 1, 1)).toHaveLength(1);
  });
});
