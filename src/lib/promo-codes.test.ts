import { describe, expect, it } from "vitest";
import {
  generatePromoCode,
  isPayingOrg,
  normalizePromoCode,
  PROMO_CODE_RE,
  promoCodeUsable,
  promoLandingUrl,
  promoRedemptionProblem,
  promoSignupUrl,
  promoTrialEnd,
  trialDaysLabel,
} from "./promo-codes";

const day = 86_400_000;
const now = new Date("2026-11-13T10:00:00Z");

describe("Aktionscodes: Normalisierung", () => {
  it("Groß-/Kleinschreibung und Leerzeichen egal, nur A–Z/0–9/-", () => {
    expect(normalizePromoCode(" podo-herbst 26 ")).toBe("PODO-HERBST26");
    expect(normalizePromoCode("PODO-7KQ4-M2XH")).toBe("PODO-7KQ4-M2XH");
    expect(normalizePromoCode("ＰＯＤＯ-１２３")).toBe("PODO-123"); // Vollbreite (NFKC)
  });
  it("lehnt ungültige Codes ab", () => {
    for (const bad of ["", "abc", "-PODO", "PODO-", "PODÖ1", "PO_DO", "a".repeat(33), "PODO/../X", "<script>", null, 42, undefined]) {
      expect(normalizePromoCode(bad), String(bad)).toBeNull();
    }
    expect(normalizePromoCode("ABCD")).toBe("ABCD");
    expect(normalizePromoCode("A".repeat(32))).toBe("A".repeat(32));
  });
  it("Zufallscodes sind gültig, ohne verwechselbare Zeichen", () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePromoCode();
      expect(c).toMatch(PROMO_CODE_RE);
      expect(c).toMatch(/^PODO-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(c.slice(5)).not.toMatch(/[01OIL]/);
    }
    expect(generatePromoCode("herbst", () => 0)).toBe("HERBST-AAAA-AAAA");
    expect(generatePromoCode("!!", () => 0)).toBe("PODO-AAAA-AAAA");
  });
});

describe("Aktionscodes: Testphase", () => {
  it("neues Ende = max(bisher, jetzt + Tage)", () => {
    expect(promoTrialEnd(null, now, 90).getTime()).toBe(now.getTime() + 90 * day);
    expect(promoTrialEnd(new Date(now.getTime() + 30 * day), now, 90).getTime()).toBe(now.getTime() + 90 * day);
    const long = new Date(now.getTime() + 200 * day);
    expect(promoTrialEnd(long, now, 90)).toEqual(long);
    // abgelaufene Testphase: ab jetzt
    expect(promoTrialEnd(new Date(now.getTime() - 40 * day), now, 90).getTime()).toBe(now.getTime() + 90 * day);
  });
  it("Tage nur 1–365, ganzzahlig", () => {
    for (const d of [0, -1, 366, 1.5, NaN]) expect(() => promoTrialEnd(null, now, d)).toThrow();
  });
  it("einlösbar nur aktiv, vor Ablauf und unter der Obergrenze", () => {
    const base = { active: true, validUntil: null, maxRedemptions: null, redemptions: 0 };
    expect(promoCodeUsable(base, now)).toBe(true);
    expect(promoCodeUsable({ ...base, active: false }, now)).toBe(false);
    expect(promoCodeUsable({ ...base, validUntil: now }, now)).toBe(false);
    expect(promoCodeUsable({ ...base, validUntil: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(promoCodeUsable({ ...base, maxRedemptions: 3, redemptions: 2 }, now)).toBe(true);
    expect(promoCodeUsable({ ...base, maxRedemptions: 3, redemptions: 3 }, now)).toBe(false);
  });
  it("nicht bei laufendem bezahlten Abo oder intern; erlaubt in Test, abgelaufen, kostenlos, beendet", () => {
    expect(promoRedemptionProblem({ plan: "trial", subscriptionStatus: "trialing" })).toBeNull();
    expect(promoRedemptionProblem({ plan: "trial", subscriptionStatus: "none" })).toBeNull();
    expect(promoRedemptionProblem({ plan: "free", subscriptionStatus: "none" })).toBeNull();
    expect(promoRedemptionProblem({ plan: "praxis", subscriptionStatus: "canceled" })).toBeNull();
    expect(promoRedemptionProblem({ plan: "praxis", subscriptionStatus: "trialing" })).toBeNull(); // Code-Testphase mit Tarif-Umfang
    expect(promoRedemptionProblem({ plan: "praxis", subscriptionStatus: "active" })).toMatch(/laufenden Abo/);
    expect(promoRedemptionProblem({ plan: "plus", subscriptionStatus: "past_due" })).toMatch(/laufenden Abo/);
    expect(promoRedemptionProblem({ plan: "starter", subscriptionStatus: "paused" })).toMatch(/laufenden Abo/);
    expect(promoRedemptionProblem({ plan: "praxis", subscriptionStatus: "trialing", stripeSubscriptionId: "sub_1" })).toMatch(/laufenden Abo/);
    expect(promoRedemptionProblem({ plan: "internal", subscriptionStatus: "active" })).toMatch(/Interne/);
  });
  it("zahlend = aktives Abo in einem bezahlten Tarif", () => {
    expect(isPayingOrg({ plan: "praxis", subscriptionStatus: "active" })).toBe(true);
    expect(isPayingOrg({ plan: "praxis", subscriptionStatus: "trialing" })).toBe(false);
    expect(isPayingOrg({ plan: "internal", subscriptionStatus: "active" })).toBe(false);
  });
});

describe("Aktionscodes: Links und Texte", () => {
  it("Registrierungs- und Aktionslink", () => {
    expect(promoSignupUrl("https://podo.example/", "PODO-AB12")).toBe("https://podo.example/einrichtung?code=PODO-AB12");
    expect(promoLandingUrl("https://podo.example", "PODO-AB12")).toBe("https://podo.example/aktion/PODO-AB12");
    expect(promoSignupUrl(undefined, "X1-Y2")).toBe("/einrichtung?code=X1-Y2");
  });
  it("Zeitraum als Text", () => {
    expect(trialDaysLabel(90)).toBe("3 Monate");
    expect(trialDaysLabel(30)).toBe("1 Monat");
    expect(trialDaysLabel(45)).toBe("45 Tage");
    expect(trialDaysLabel(365)).toBe("1 Jahr");
  });
});
