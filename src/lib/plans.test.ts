import { describe, expect, it } from "vitest";
import { accessMode, assertEntitled, EntitlementError, entitlements, FREE_MAX_PATIENTS, freeSwitchProblem, monthlyPriceCents, patientLimit, patientLimitProblem, seatLimit, seatProblem, type OrgBilling } from "./plans";

const now = new Date("2026-11-08T12:00:00Z");
const day = 86_400_000;
const org = (o: Partial<OrgBilling>): OrgBilling => ({ plan: "trial", subscriptionStatus: "trialing", trialEndsAt: null, currentPeriodEnd: null, seats: 1, ...o });

describe("Zugriffsmodus (Nur-Lesen)", () => {
  it("Testphase: voll mit Resttagen, danach nur lesen", () => {
    expect(accessMode(org({ trialEndsAt: new Date(now.getTime() + 2.5 * day) }), now)).toEqual({ mode: "full", trialDaysLeft: 3 });
    expect(accessMode(org({ trialEndsAt: new Date(now.getTime() - 1000) }), now)).toEqual({ mode: "readonly", reason: "trial_expired" });
  });
  it("aktives Abo und interne Praxis: immer voll", () => {
    expect(accessMode(org({ plan: "praxis", subscriptionStatus: "active", currentPeriodEnd: new Date(0) }), now).mode).toBe("full");
    expect(accessMode(org({ plan: "internal", subscriptionStatus: "canceled" }), now).mode).toBe("full");
  });
  it("überfällig/gekündigt: 14 Tage Kulanz ab Periodenende, dann nur lesen", () => {
    const end = new Date(now.getTime() - 10 * day);
    const grace = accessMode(org({ plan: "praxis", subscriptionStatus: "past_due", currentPeriodEnd: end }), now);
    expect(grace.mode).toBe("full");
    expect(grace.graceEndsAt).toEqual(new Date(end.getTime() + 14 * day));
    const old = new Date(now.getTime() - 15 * day);
    expect(accessMode(org({ plan: "praxis", subscriptionStatus: "past_due", currentPeriodEnd: old }), now)).toEqual({ mode: "readonly", reason: "payment_overdue" });
    expect(accessMode(org({ plan: "plus", subscriptionStatus: "canceled", currentPeriodEnd: old }), now)).toEqual({ mode: "readonly", reason: "canceled" });
    expect(accessMode(org({ plan: "plus", subscriptionStatus: "canceled" }), now).mode).toBe("readonly");
  });
});

describe("Entitlements", () => {
  it("Funktionen je Tarif", () => {
    const active = { subscriptionStatus: "active" };
    expect([...entitlements(org({ ...active, plan: "starter" }), now).features]).toEqual([]);
    expect(entitlements(org({ ...active, plan: "praxis" }), now).features.has("voice_agent")).toBe(false);
    expect(entitlements(org({ ...active, plan: "praxis" }), now).features.has("portal")).toBe(true);
    expect(entitlements(org({ ...active, plan: "plus" }), now).features.has("voice_agent")).toBe(true);
    expect(entitlements(org({ trialEndsAt: new Date(now.getTime() + day) }), now).features.has("voice_agent")).toBe(true);
  });
  it("assertEntitled: fehlende Funktion und Nur-Lesen-Modus werfen", () => {
    expect(() => assertEntitled(org({ plan: "starter", subscriptionStatus: "active" }), "portal", now)).toThrow(EntitlementError);
    expect(() => assertEntitled(org({ plan: "starter", subscriptionStatus: "active" }), "portal", now)).toThrow(/Patientenportal.*Starter/);
    expect(() => assertEntitled(org({ trialEndsAt: new Date(now.getTime() - day) }), "portal", now)).toThrow(/Nur-Lesen/);
    expect(() => assertEntitled(org({ plan: "plus", subscriptionStatus: "active" }), "voice_agent", now)).not.toThrow();
  });
  it("Preise (vorläufig): Grundpreis + 15 € je Zusatzplatz", () => {
    expect(monthlyPriceCents("starter", 1)).toBe(5900);
    expect(monthlyPriceCents("praxis", 4)).toBe(9900 + 2 * 1500);
  });
});

describe("Plätze", () => {
  it("Limits je Tarif", () => {
    expect(seatLimit({ plan: "trial", seats: 9 })).toBe(9);
    expect(seatLimit({ plan: "trial", seats: 40 })).toBe(10);
    expect(seatLimit({ plan: "starter", seats: 3 })).toBe(1);
    expect(seatLimit({ plan: "praxis", seats: 9 })).toBe(5);
    expect(seatLimit({ plan: "praxis", seats: 1 })).toBe(2);
    expect(seatLimit({ plan: "plus", seats: 12 })).toBe(12);
    expect(seatLimit({ plan: "internal", seats: 1 })).toBe(Infinity);
  });
  it("seatProblem: blockiert über dem Limit, Steuerberatung zählt nie", () => {
    expect(seatProblem({ plan: "starter", seats: 1 }, 0, "owner")).toBeNull();
    expect(seatProblem({ plan: "starter", seats: 1 }, 1, "therapist")).toMatch(/Plätze.*belegt.*Abo & Tarif/);
    expect(seatProblem({ plan: "starter", seats: 1 }, 1, "accountant")).toBeNull();
    expect(seatProblem({ plan: "trial", seats: 1 }, 1, "reception")).toBeNull();
    expect(seatProblem({ plan: "trial", seats: 1 }, 2, "reception")).not.toBeNull();
  });
});

describe("Kostenlos-Tarif", () => {
  it("läuft nie ab, 1 Platz, keine Zusatzfunktionen, 20 Patient:innen", () => {
    const free = org({ plan: "free", subscriptionStatus: "none", trialEndsAt: new Date(now.getTime() - 90 * day) });
    expect(accessMode(free, now)).toEqual({ mode: "full" });
    expect(seatLimit(free)).toBe(1);
    expect(entitlements(free, now).features.size).toBe(0);
    expect(patientLimit(free)).toBe(FREE_MAX_PATIENTS);
    expect(patientLimit(org({ plan: "praxis" }))).toBe(Infinity);
    expect(() => assertEntitled(free, "portal", now)).toThrow(/nicht enthalten/);
  });
  it("Patienten-Grenze: 20 erlaubt, 21. nicht; Mehrfach-Import zählt alle", () => {
    const free = org({ plan: "free" });
    expect(patientLimitProblem(free, 19)).toBeNull();
    expect(patientLimitProblem(free, 20)).toMatch(/höchstens 20 aktive/);
    expect(patientLimitProblem(free, 15, 5)).toBeNull();
    expect(patientLimitProblem(free, 15, 6)).toMatch(/frei: 5/);
    expect(patientLimitProblem(org({ plan: "starter" }), 5000, 100)).toBeNull();
  });
  it("Wechsel: nicht bei laufendem Abo, über 20 Patient:innen oder mit Team", () => {
    expect(freeSwitchProblem(org({ plan: "trial" }), 20)).toBeNull();
    expect(freeSwitchProblem(org({ plan: "trial" }), 21)).toMatch(/archivieren/);
    expect(freeSwitchProblem(org({ plan: "trial" }), 3, 2)).toMatch(/eine Person/);
    expect(freeSwitchProblem(org({ plan: "praxis", subscriptionStatus: "active" }), 3)).toMatch(/kündigen/);
    expect(freeSwitchProblem(org({ plan: "praxis", subscriptionStatus: "canceled" }), 3)).toBeNull();
    expect(freeSwitchProblem(org({ plan: "free" }), 3)).toMatch(/bereits/);
  });
});
