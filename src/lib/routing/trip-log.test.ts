import { describe, expect, it } from "vitest";
import { applyCorrections, isPrivatePayer, monthTotals, navigationLinks, osmLegLink, travelKm, travelLineDescription, tripLogRows, tripSettings, tripTargetLabel, type CorrectionRow, type TripRow } from "./trip-log";
import { renderTripLogPdf } from "./trip-pdf";

const trip = (o: Partial<TripRow> = {}): TripRow => ({
  id: "t1",
  tripDate: "2026-11-09",
  startedAt: new Date("2026-11-09T08:00:00Z"),
  fromLabel: "Praxis",
  toLabel: tripTargetLabel(17),
  purpose: "Hausbesuch",
  distanceM: 12_430,
  durationSec: 1100,
  distanceSource: "route",
  appointmentId: "a1",
  vehicleLabel: "VW Polo",
  plate: "P-AB 123",
  odometerStart: 48210,
  driverId: "u1",
  ...o,
});
const corr = (o: Partial<CorrectionRow>): CorrectionRow => ({
  id: Math.random().toString(36),
  tripId: "t1",
  kind: "correction",
  distanceM: null,
  durationSec: null,
  purpose: null,
  odometerStart: null,
  odometerEnd: null,
  arrivedAt: null,
  voided: false,
  reason: "Test",
  createdBy: "u2",
  createdAt: new Date("2026-11-09T10:00:00Z"),
  ...o,
});

describe("Fahrtenbuch: Pseudonymisierung", () => {
  it("Ziel nur als Patientennummer, nie mit Namen", () => {
    expect(tripTargetLabel(17)).toBe("Hausbesuch K-17");
    expect(tripTargetLabel(null)).toBe("Hausbesuch");
    expect(tripTargetLabel(0)).toBe("Hausbesuch");
  });

  it("CSV-Zeilen enthalten nur die Pseudonyme und die Steuer-Spalten", () => {
    const rows = tripLogRows([applyCorrections(trip(), [])]);
    expect(rows[0].slice(0, 5)).toEqual(["Datum", "Start", "Ziel (pseudonymisiert)", "Zweck", "km"]);
    expect(rows[0]).toContain("Kennzeichen");
    expect(rows[1]).toEqual(["09.11.2026", "Praxis", "Hausbesuch K-17", "Hausbesuch", "12,4", "berechnet", "P-AB 123", "48210", "", ""]);
    expect(JSON.stringify(rows)).not.toMatch(/Muster|Erika/);
  });

  it("PDF-Export enthält Pseudonym und Hinweis „Hilfe“", async () => {
    const bytes = await renderTripLogPdf({
      practice: "Testpraxis",
      monthLabel: "November 2026",
      vehicle: "VW Polo",
      plate: "P-AB 123",
      trips: [applyCorrections(trip(), [])],
      totals: { count: 1, distanceM: 12_430, estimated: 0 },
      createdAt: new Date("2026-11-30T10:00:00Z"),
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe("Fahrtenbuch: Nachträge (append-only)", () => {
  it("spätere Korrektur überschreibt km, Original bleibt erhalten", () => {
    const e = applyCorrections(trip(), [
      corr({ kind: "arrival", arrivedAt: new Date("2026-11-09T08:20:00Z"), odometerEnd: 48223, createdAt: new Date("2026-11-09T08:20:00Z") }),
      corr({ distanceM: 13_000, createdAt: new Date("2026-11-09T12:00:00Z") }),
      corr({ distanceM: 12_900, createdAt: new Date("2026-11-09T11:00:00Z") }),
    ]);
    expect(e.distanceM).toBe(13_000);
    expect(e.originalDistanceM).toBe(12_430);
    expect(e.distanceSource).toBe("manual");
    expect(e.odometerEnd).toBe(48223);
    expect(e.corrected).toBe(true);
    expect(e.corrections).toHaveLength(3);
  });

  it("Storno zählt nicht in die Summe", () => {
    const a = applyCorrections(trip(), []);
    const b = applyCorrections(trip({ id: "t2", distanceSource: "estimate" }), [corr({ tripId: "t2", kind: "void", voided: true })]);
    const c = applyCorrections(trip({ id: "t3", distanceSource: "estimate", distanceM: 5000 }), []);
    expect(monthTotals([a, b, c])).toEqual({ count: 2, distanceM: 17_430, durationSec: 2200, estimated: 1 });
    expect(tripLogRows([b])[1][9]).toBe("storniert");
  });
});

describe("Einstellungen, Wegegeld, Links", () => {
  it("liest Einstellungen tolerant (kein voreingestellter km-Satz)", () => {
    expect(tripSettings({})).toEqual({ vehicleLabel: null, plate: null, rateCents: null, billing: "oneway", returnToStart: true });
    expect(tripSettings({ trips: { rateCents: 30, billing: "roundtrip", returnToStart: false, plate: " P-X 1 " } })).toMatchObject({ rateCents: 30, billing: "roundtrip", returnToStart: false, plate: "P-X 1" });
    expect(tripSettings({ trips: { rateCents: -5 } }).rateCents).toBeNull();
  });

  it("Wegegeld: km mit einer Nachkommastelle, Hin- und Rückweg × 2", () => {
    expect(travelKm(12_430, "oneway")).toBe(12.4);
    expect(travelKm(12_430, "roundtrip")).toBe(24.8);
    expect(travelLineDescription("2026-11-09", 12_430, "roundtrip")).toBe("Wegegeld Hausbesuch am 09.11.2026 (12,4 km, Hin- und Rückweg)");
    expect(isPrivatePayer("self")).toBe(true);
    expect(isPrivatePayer("pkv")).toBe(true);
    expect(isPrivatePayer("gkv")).toBe(false);
  });

  it("Navigations-Links enthalten nur die Adresse (kodiert)", () => {
    const l = navigationLinks("Hauptstraße 1, 14467 Potsdam");
    expect(l.google).toBe("https://www.google.com/maps/dir/?api=1&destination=Hauptstra%C3%9Fe%201%2C%2014467%20Potsdam&travelmode=driving");
    expect(l.apple.startsWith("https://maps.apple.com/?daddr=Hauptstra%C3%9Fe")).toBe(true);
    expect(osmLegLink({ lat: 52.4, lon: 13.06 }, { lat: 52.41, lon: 13.1 })).toContain("route=52.4000%2C13.0600%3B52.4100%2C13.1000");
  });
});
