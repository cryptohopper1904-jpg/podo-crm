/** KI-Telefon: Minutenzählung, Monatsgrenzen (Berlin), Freischaltung je Tarif/Zusatzmodul, Monatsbericht. */
import { describe, expect, it } from "vitest";
import { PLANS, voiceEntitlement, type OrgBilling } from "./plans";
import { berlinMonth, monthBounds, recentMonths, voiceMonthReport, voiceUsage } from "./voice-usage";

const NOW = new Date("2030-03-15T10:00:00Z");
const billing = (plan: string, over: Partial<OrgBilling> = {}): OrgBilling => ({ plan, subscriptionStatus: plan === "trial" ? "trialing" : "active", trialEndsAt: plan === "trial" ? new Date("2030-04-01T00:00:00Z") : null, currentPeriodEnd: null, seats: 1, ...over });

describe("voiceUsage", () => {
  it("rundet angefangene Minuten auf und berechnet Rest/Prozent", () => {
    expect(voiceUsage(0, 300)).toMatchObject({ usedMinutes: 0, remainingMinutes: 300, percent: 0, exceeded: false, warn: false });
    expect(voiceUsage(61, 300)).toMatchObject({ usedMinutes: 2, remainingMinutes: 298 });
    expect(voiceUsage(240 * 60, 300)).toMatchObject({ usedMinutes: 240, percent: 80, warn: true, exceeded: false });
  });

  it("Grenze: genau ausgeschöpft bzw. überschritten → exceeded, Balken gedeckelt", () => {
    expect(voiceUsage(300 * 60, 300)).toMatchObject({ exceeded: true, warn: false, percent: 100, remainingMinutes: 0 });
    expect(voiceUsage(299 * 60 + 1, 300).exceeded).toBe(true); // 299:01 → 300 angefangene Minuten
    expect(voiceUsage(299 * 60, 300).exceeded).toBe(false);
    expect(voiceUsage(400 * 60, 300).percent).toBe(100);
  });

  it("ohne Freiminuten immer erschöpft; Unsinn wird abgefangen", () => {
    expect(voiceUsage(0, 0).exceeded).toBe(true);
    expect(voiceUsage(Number.NaN, 30)).toMatchObject({ usedSeconds: 0, exceeded: false });
    expect(voiceUsage(-50, 30).usedMinutes).toBe(0);
  });
});

describe("Monatsgrenzen (Europe/Berlin)", () => {
  it("Monat und Grenzen inkl. Zeitzone", () => {
    expect(berlinMonth(new Date("2030-03-31T22:30:00Z"))).toBe("2030-04"); // 00:30 Berlin (Sommerzeit)
    const { from, to } = monthBounds("2030-03");
    expect(from.toISOString()).toBe("2030-02-28T23:00:00.000Z");
    expect(to.toISOString()).toBe("2030-03-31T22:00:00.000Z");
    expect(monthBounds("2030-12").to.toISOString()).toBe("2030-12-31T23:00:00.000Z");
    expect(recentMonths(new Date("2030-02-10T12:00:00Z"), 3)).toEqual(["2030-02", "2030-01", "2029-12"]);
  });
});

describe("voiceEntitlement", () => {
  it("Freiminuten je Tarif", () => {
    expect(PLANS.trial.voiceMinutesIncluded).toBe(30);
    expect(PLANS.plus.voiceMinutesIncluded).toBe(300);
    expect(voiceEntitlement(billing("trial"), {}, NOW)).toMatchObject({ enabled: true, includedMinutes: 30, source: "plan" });
    expect(voiceEntitlement(billing("plus"), {}, NOW)).toMatchObject({ enabled: true, includedMinutes: 300, source: "plan" });
    expect(voiceEntitlement(billing("starter"), { voiceAddon: true }, NOW)).toMatchObject({ enabled: false, addonAvailable: false });
  });

  it("Praxis: nur mit Zusatzmodul", () => {
    expect(voiceEntitlement(billing("praxis"), {}, NOW)).toMatchObject({ enabled: false, includedMinutes: 0, addonAvailable: true });
    expect(voiceEntitlement(billing("praxis"), {}, NOW).reason).toMatch(/Zusatzmodul/);
    expect(voiceEntitlement(billing("praxis"), { voiceAddon: true }, NOW)).toMatchObject({ enabled: true, includedMinutes: 300, source: "addon" });
    expect(voiceEntitlement(billing("praxis"), { voiceAddon: "true" }, NOW).enabled).toBe(false);
  });

  it("Nur-Lesen-Modus (abgelaufene Testphase) → aus", () => {
    const e = voiceEntitlement(billing("trial", { trialEndsAt: new Date("2030-03-01T00:00:00Z") }), {}, NOW);
    expect(e.enabled).toBe(false);
    expect(e.reason).toMatch(/Testphase/);
  });
});

describe("voiceMonthReport", () => {
  it("zählt Anrufe, Buchungen, Rückrufe, Ø Dauer je Monat", () => {
    const rows = voiceMonthReport(
      [
        { startedAt: new Date("2030-03-02T09:00:00Z"), durationSec: 60, outcome: "booked" },
        { startedAt: new Date("2030-03-03T09:00:00Z"), durationSec: 120, outcome: "callback" },
        { startedAt: new Date("2030-03-04T09:00:00Z"), durationSec: null, outcome: "info" },
        { startedAt: new Date("2030-02-27T09:00:00Z"), durationSec: 30, outcome: "callback" },
        { startedAt: new Date("2029-01-01T09:00:00Z"), durationSec: 30, outcome: "booked" },
      ],
      ["2030-03", "2030-02"],
    );
    expect(rows).toEqual([
      { month: "2030-03", calls: 3, booked: 1, callbacks: 1, totalSec: 180, avgSec: 90 },
      { month: "2030-02", calls: 1, booked: 0, callbacks: 1, totalSec: 30, avgSec: 30 },
    ]);
  });
});
