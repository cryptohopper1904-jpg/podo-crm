import { describe, expect, it } from "vitest";
import { berlinToUtc } from "./format";
import { dayRange, isBookableOnline, parseOnlineBookingSettings, portalSlots, rescheduleCheck } from "./portal-booking";

const DAY = "2030-03-05"; // Dienstag
const at = (t: string, d = DAY) => berlinToUtc(d, t);
const hhmm = (d: Date) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(d);

describe("Patientenportal: Einstellungen & Leistungen", () => {
  it("liest Vorlaufzeit/Tageslimit, Standard 2 h ohne Limit", () => {
    expect(parseOnlineBookingSettings({})).toEqual({ enabled: true, serviceCodes: [], leadHours: 2, maxPerDay: null });
    expect(parseOnlineBookingSettings({ onlineBooking: { enabled: false, leadHours: 24, maxPerDay: 3, serviceCodes: ["PK", 4] } })).toEqual({ enabled: false, serviceCodes: ["PK"], leadHours: 24, maxPerDay: 3 });
    expect(parseOnlineBookingSettings({ onlineBooking: { leadHours: -1, maxPerDay: 0 } })).toMatchObject({ leadHours: 2, maxPerDay: null });
  });
  it("nur aktive Behandlungs-/Kosmetikleistungen, ggf. aus der Freigabeliste", () => {
    const s = { code: "PK", category: "treatment", active: true, durationMin: 40 };
    expect(isBookableOnline(s, { serviceCodes: [] })).toBe(true);
    expect(isBookableOnline(s, { serviceCodes: ["FP"] })).toBe(false);
    expect(isBookableOnline({ ...s, category: "product" }, { serviceCodes: [] })).toBe(false);
    expect(isBookableOnline({ ...s, active: false }, { serviceCodes: [] })).toBe(false);
    expect(isBookableOnline({ ...s, durationMin: 0 }, { serviceCodes: [] })).toBe(false);
  });
  it("6-Wochen-Fenster als Tagesliste", () => {
    const d = dayRange("2030-03-30", 3);
    expect(d).toEqual(["2030-03-30", "2030-03-31", "2030-04-01"]); // über die Zeitumstellung hinweg
  });
});

describe("Patientenportal: Slot-Finder", () => {
  const days = [{ dateIso: DAY, ranges: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "15:00" }] }];
  const base = { days, busy: [], durationMin: 60, earliest: new Date(0) };

  it("nur innerhalb der Arbeitszeiten, Termin muss ganz hineinpassen", () => {
    const [d] = portalSlots(base);
    expect(d.slots.map(hhmm)).toEqual(["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "13:00", "13:30", "14:00"]);
  });
  it("belegte Termine blockieren überlappende Startzeiten", () => {
    const [d] = portalSlots({ ...base, busy: [{ startsAt: at("09:00"), endsAt: at("09:40") }] });
    expect(d.slots.map(hhmm)).not.toContain("08:30");
    expect(d.slots.map(hhmm)).not.toContain("09:30");
    expect(d.slots.map(hhmm)).toContain("08:00");
    expect(d.slots.map(hhmm)).toContain("10:00");
  });
  it("Vorlaufzeit: nichts vor `earliest`", () => {
    const [d] = portalSlots({ ...base, earliest: at("10:15") });
    expect(d.slots.map(hhmm)[0]).toBe("10:30");
  });
  it("Tageslimit für Online-Buchungen", () => {
    const full = portalSlots({ ...base, maxPerDay: 2, onlinePerDay: new Map([[DAY, 2]]) });
    expect(full[0].slots).toEqual([]);
    const ok = portalSlots({ ...base, maxPerDay: 3, onlinePerDay: new Map([[DAY, 2]]) });
    expect(ok[0].slots.length).toBeGreaterThan(0);
  });
  it("beim Verschieben zählt der eigene Termin nicht als belegt", () => {
    const own = { id: "a1", startsAt: at("08:00"), endsAt: at("12:00") };
    expect(portalSlots({ ...base, busy: [own] })[0].slots.map(hhmm)).toEqual(["13:00", "13:30", "14:00"]);
    expect(portalSlots({ ...base, busy: [own], excludeId: "a1" })[0].slots).toHaveLength(10);
  });
  it("überlappende Zeitfenster mehrerer Personen erzeugen keine doppelten Zeiten", () => {
    const [d] = portalSlots({ ...base, days: [{ dateIso: DAY, ranges: [{ start: "08:00", end: "10:00" }, { start: "09:00", end: "10:00" }] }] });
    expect(d.slots.map(hhmm)).toEqual(["08:00", "08:30", "09:00"]);
  });
});

describe("Patientenportal: Verschieben bis 24 h vorher", () => {
  const now = at("09:00", "2030-03-04");
  it("erlaubt ≥ 24 h vor dem alten Termin", () => {
    expect(rescheduleCheck(at("09:00"), at("11:00"), { now })).toEqual({ ok: true });
    expect(rescheduleCheck(at("09:00"), at("11:00"), { now: new Date(now.getTime() + 1) })).toEqual({ ok: false, reason: "too_late" });
  });
  it("neuer Termin muss die Vorlaufzeit einhalten und sich unterscheiden", () => {
    expect(rescheduleCheck(at("12:00"), at("10:00", "2030-03-04"), { now, leadHours: 2 })).toEqual({ ok: false, reason: "lead_time" });
    expect(rescheduleCheck(at("12:00"), at("11:00", "2030-03-04"), { now, leadHours: 2 })).toEqual({ ok: true });
    expect(rescheduleCheck(at("12:00"), at("12:00"), { now })).toEqual({ ok: false, reason: "same" });
  });
});
