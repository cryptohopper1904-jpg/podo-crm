import { describe, expect, it } from "vitest";
import {
  addMonthsUtc,
  earliestAutoDeletion,
  isAutoDeletion,
  needsManualNotice,
  noticeDeliveredAt,
  NOTICE_LEAD_DAYS,
  plannedDeletionDate,
  readonlyExpiry,
  readonlyExpiryEnabled,
  readonlyExpiryState,
} from "./readonly-expiry";

const DAY = 86_400_000;
const now = new Date("2026-11-14T10:00:00Z");
const base = { plan: "starter", subscriptionStatus: "canceled", trialEndsAt: null as Date | null, currentPeriodEnd: null as Date | null, seats: 1, stripeSubscriptionId: null as string | null };

describe("Ende des Nur-Lesen-Modus: Fristen", () => {
  it("Kalendermonate (UTC), Monatsende bleibt gültig", () => {
    expect(addMonthsUtc(new Date("2026-01-31T08:00:00Z"), 1).toISOString()).toBe("2026-02-28T08:00:00.000Z");
    expect(addMonthsUtc(new Date("2024-02-29T00:00:00Z"), 12).toISOString()).toBe("2025-02-28T00:00:00.000Z");
    expect(addMonthsUtc(new Date("2025-11-14T10:00:00Z"), 12).toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });

  it("beendetes Abo: 12 Monate ab Ende des bezahlten Zeitraums (nach 14 Tagen Kulanz im Nur-Lesen-Modus)", () => {
    const end = new Date("2026-03-01T00:00:00Z");
    const x = readonlyExpiry({ ...base, currentPeriodEnd: end }, now)!;
    expect(x.contractEnd).toEqual(end);
    expect(x.kind).toBe("contract");
    expect(x.deletionAt.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(x.requestAt.getTime()).toBe(x.deletionAt.getTime() - 30 * DAY);
    expect(x.noticeAt.getTime()).toBe(x.deletionAt.getTime() - NOTICE_LEAD_DAYS * DAY);
    expect(NOTICE_LEAD_DAYS).toBeGreaterThanOrEqual(30);
    // innerhalb der 14 Tage Kulanz noch voller Zugriff → keine Frist
    expect(readonlyExpiry({ ...base, currentPeriodEnd: new Date(now.getTime() - 5 * DAY) }, now)).toBeNull();
    expect(readonlyExpiry({ ...base, subscriptionStatus: "none", currentPeriodEnd: end }, now)?.contractEnd).toEqual(end);
  });

  it("Testphase (auch per Aktionscode mit Tarif-Umfang): 12 Monate ab Ende der Testphase", () => {
    const trialEnd = new Date("2026-06-10T12:00:00Z");
    const t = readonlyExpiry({ ...base, plan: "trial", subscriptionStatus: "trialing", trialEndsAt: trialEnd }, now)!;
    expect(t.contractEnd).toEqual(trialEnd);
    expect(t.kind).toBe("trial");
    expect(t.deletionAt.toISOString()).toBe("2027-06-10T12:00:00.000Z");
    expect(readonlyExpiry({ ...base, plan: "trial", subscriptionStatus: "none", trialEndsAt: trialEnd }, now)?.contractEnd).toEqual(trialEnd);
    expect(readonlyExpiry({ ...base, plan: "praxis", subscriptionStatus: "trialing", trialEndsAt: trialEnd }, now)?.contractEnd).toEqual(trialEnd);
    // Testphase läuft noch
    expect(readonlyExpiry({ ...base, plan: "trial", subscriptionStatus: "trialing", trialEndsAt: new Date(now.getTime() + DAY) }, now)).toBeNull();
  });

  it("keine Frist: Tarif aktiv, Kostenlos, Intern, Zahlung nur überfällig, laufendes (z. B. pausiertes) Stripe-Abo, kein Stichtag", () => {
    const old = new Date("2025-01-01T00:00:00Z");
    expect(readonlyExpiry({ ...base, subscriptionStatus: "active", currentPeriodEnd: old }, now)).toBeNull();
    expect(readonlyExpiry({ ...base, plan: "free", subscriptionStatus: "none", currentPeriodEnd: old }, now)).toBeNull();
    expect(readonlyExpiry({ ...base, plan: "internal", subscriptionStatus: "none", currentPeriodEnd: old }, now)).toBeNull();
    expect(readonlyExpiry({ ...base, subscriptionStatus: "past_due", currentPeriodEnd: old, stripeSubscriptionId: "sub_1" }, now)).toBeNull();
    expect(readonlyExpiry({ ...base, subscriptionStatus: "paused", currentPeriodEnd: old, stripeSubscriptionId: "sub_1" }, now)).toBeNull();
    expect(readonlyExpiry({ ...base }, now)).toBeNull();
  });

  it("voraussichtlicher Termin: Antrag + 30 Tage, sonst spätester Termin, aber nie früher als 30 Tage ab jetzt", () => {
    const x = readonlyExpiry({ ...base, currentPeriodEnd: new Date("2025-10-01T00:00:00Z") }, now)!; // Frist schon überschritten (Altfall)
    const empty = readonlyExpiryState({});
    expect(plannedDeletionDate(x, empty, null, now).getTime()).toBe(now.getTime() + 30 * DAY);
    const req = new Date("2026-11-01T00:00:00Z");
    expect(plannedDeletionDate(x, empty, req, now).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    const later = readonlyExpiry({ ...base, currentPeriodEnd: new Date("2026-08-01T00:00:00Z") }, now)!;
    expect(plannedDeletionDate(later, empty, null, now).toISOString()).toBe("2027-08-01T00:00:00.000Z");
    expect(plannedDeletionDate(later, readonlyExpiryState({ readonlyExpiry: { deletionAt: "2027-09-01T00:00:00.000Z" } }), null, now).toISOString()).toBe("2027-09-01T00:00:00.000Z");
  });

  it("Zustand nur aus gültigen Werten", () => {
    expect(readonlyExpiryState({ readonlyExpiry: { noticeSentAt: "x", noticeMail: "irgendwas", reminderMail: "sent" } })).toEqual({
      deletionAt: null,
      noticeSentAt: null,
      noticeMail: null,
      reminderSentAt: null,
      reminderMail: "sent",
      manualNoticeAt: null,
      manualNoticeVia: null,
      noticeAttempts: 0,
      accountantNotified: false,
    });
    // Versuchszähler (Code CR-2): ältere Stände ohne Zähler zählen als ein Versuch, ungültige Werte ebenso
    const sent = "2026-11-01T00:00:00.000Z";
    expect(readonlyExpiryState({ readonlyExpiry: { noticeSentAt: sent } }).noticeAttempts).toBe(1);
    expect(readonlyExpiryState({ readonlyExpiry: { noticeSentAt: sent, noticeAttempts: 3, accountantNotified: true } })).toMatchObject({ noticeAttempts: 3, accountantNotified: true });
    expect(readonlyExpiryState({ readonlyExpiry: { noticeSentAt: sent, noticeAttempts: "9", accountantNotified: "ja" } })).toMatchObject({ noticeAttempts: 1, accountantNotified: false });
    expect(isAutoDeletion({ deletionReason: "auto_readonly_expiry" })).toBe(true);
    expect(isAutoDeletion({ deletionReason: "owner" })).toBe(false);
    expect(isAutoDeletion(null)).toBe(false);
  });

  it("Zugang der Ankündigung: E-Mail versendet oder Betreiber-Vermerk; Termin nie vor Zugang + 30 Tagen", () => {
    const noticed = "2026-11-01T00:00:00.000Z";
    const st = (x: Record<string, unknown>) => readonlyExpiryState({ readonlyExpiry: { noticeSentAt: noticed, deletionAt: "2026-12-01T00:00:00.000Z", ...x } });
    // nicht zugestellt (inkl. abgebrochenem Lauf „unknown“): kein Zugang, Pflichtaktion
    for (const mail of ["not_configured", "failed", "no_recipient", "unknown"]) {
      expect(noticeDeliveredAt(st({ noticeMail: mail }))).toBeNull();
      expect(earliestAutoDeletion(st({ noticeMail: mail }))).toBeNull();
      expect(needsManualNotice(st({ noticeMail: mail }))).toBe(true);
    }
    expect(needsManualNotice(readonlyExpiryState({}))).toBe(false);
    // E-Mail versendet
    expect(noticeDeliveredAt(st({ noticeMail: "sent" }))?.toISOString()).toBe(noticed);
    expect(earliestAutoDeletion(st({ noticeMail: "sent" }))?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    // von Hand angekündigt, Zugang später → Termin verschiebt sich auf Zugang + 30 Tage
    const manual = st({ noticeMail: "not_configured", manualNoticeAt: "2026-11-20T10:00:00.000Z", manualNoticeVia: "letter" });
    expect(needsManualNotice(manual)).toBe(false);
    expect(manual.manualNoticeVia).toBe("letter");
    expect(earliestAutoDeletion(manual)?.toISOString()).toBe("2026-12-20T10:00:00.000Z");
    const x = readonlyExpiry({ ...base, currentPeriodEnd: new Date("2025-10-01T00:00:00Z") }, now)!;
    expect(plannedDeletionDate(x, manual, null, now).toISOString()).toBe("2026-12-20T10:00:00.000Z");
    expect(readonlyExpiryState({ readonlyExpiry: { manualNoticeVia: "taube" } }).manualNoticeVia).toBeNull();
  });

  it("Schalter READONLY_EXPIRY_ENABLED: nur „1“ schaltet ein", () => {
    expect(readonlyExpiryEnabled({})).toBe(false);
    expect(readonlyExpiryEnabled({ READONLY_EXPIRY_ENABLED: "true" })).toBe(false);
    expect(readonlyExpiryEnabled({ READONLY_EXPIRY_ENABLED: "1" })).toBe(true);
  });
});
