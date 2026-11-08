import { describe, expect, it } from "vitest";
import { berlinToUtc } from "./format";
import { matchWaitlist, offerExpiry, offerText, parseWishes, serializeWishes, wishesMatch } from "./waitlist";

const svc = [
  { id: "s-pk", name: "Podologische Komplexbehandlung", code: "PK" },
  { id: "s-fp", name: "Fußpflege kosmetisch", code: "FP" },
];
// Dienstag 10:00 Berlin
const slot = { startsAt: berlinToUtc("2030-03-05", "10:00"), endsAt: berlinToUtc("2030-03-05", "10:40"), serviceIds: ["s-pk"] };

describe("Warteliste: Wünsche", () => {
  it("JSON-Format hin und zurück", () => {
    const w = parseWishes(serializeWishes({ serviceIds: ["s-pk"], weekdays: [2, 2, 9], dayparts: ["morning"], note: " gern früh " }));
    expect(w).toEqual({ serviceIds: ["s-pk"], weekdays: [2], dayparts: ["morning"], note: "gern früh" });
  });
  it("Freitext-Heuristik: Wochentage, Tageszeit, Leistung", () => {
    const w = parseWishes("Di/Do vormittags, Komplexbehandlung", [{ id: "x", name: "Komplexbehandlung" }]);
    expect(w.weekdays).toEqual([2, 4]);
    expect(w.dayparts).toEqual(["morning"]);
    expect(w.serviceIds).toEqual(["x"]);
    expect(parseWishes("so bald wie möglich").weekdays).toEqual([]);
    expect(parseWishes("werktags nachmittags").weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parseWishes("").weekdays).toEqual([]);
  });
  it("Abgleich mit dem freien Termin", () => {
    const w = (x: object) => ({ serviceIds: [], weekdays: [], dayparts: [], note: null, ...x });
    expect(wishesMatch(w({}), slot)).toBe(true);
    expect(wishesMatch(w({ weekdays: [2] }), slot)).toBe(true);
    expect(wishesMatch(w({ weekdays: [1, 3] }), slot)).toBe(false);
    expect(wishesMatch(w({ dayparts: ["afternoon"] }), slot)).toBe(false);
    expect(wishesMatch(w({ dayparts: ["morning"] }), slot)).toBe(true);
    expect(wishesMatch(w({ serviceIds: ["s-fp"] }), slot)).toBe(false);
    expect(wishesMatch(w({ serviceIds: ["s-fp", "s-pk"] }), slot)).toBe(true);
  });
});

describe("Warteliste: Auswahl", () => {
  const e = (id: string, patientId: string, wishes: string | null, day: number) => ({ id, patientId, wishes, createdAt: new Date(Date.UTC(2030, 0, day)) });
  const entries = [
    e("3", "p3", null, 3),
    e("1", "p1", serializeWishes({ weekdays: [2] }), 1),
    e("2", "p2", serializeWishes({ dayparts: ["afternoon"] }), 2),
    e("4", "p1", null, 4), // doppelte Person
    e("5", "p5", "Fußpflege kosmetisch", 5),
    e("6", "p6", "Komplexbehandlung dienstags", 6),
  ];
  it("älteste passende zuerst, je Person einmal, ohne Ausgeschlossene, mit Limit", () => {
    expect(matchWaitlist(entries, slot, { services: svc }).map((x) => x.id)).toEqual(["1", "3", "6"]);
    expect(matchWaitlist(entries, slot, { services: svc, excludePatientIds: ["p1"] }).map((x) => x.id)).toEqual(["3", "6"]);
    expect(matchWaitlist(entries, slot, { services: svc, limit: 1 }).map((x) => x.id)).toEqual(["1"]);
  });
});

describe("Warteliste: Angebot", () => {
  const now = berlinToUtc("2030-03-04", "09:00");
  it("Gültigkeit: 24 h, aber spätestens 3 h vor Beginn; zu kurzfristig → kein Angebot", () => {
    const early = berlinToUtc("2030-03-04", "05:00");
    expect(offerExpiry(slot.startsAt, early)?.toISOString()).toBe(new Date(early.getTime() + 24 * 3600_000).toISOString());
    expect(offerExpiry(slot.startsAt, now)?.toISOString()).toBe(berlinToUtc("2030-03-05", "07:00").toISOString());
    expect(offerExpiry(slot.startsAt, berlinToUtc("2030-03-05", "05:00"))?.toISOString()).toBe(berlinToUtc("2030-03-05", "07:00").toISOString());
    expect(offerExpiry(slot.startsAt, berlinToUtc("2030-03-05", "06:45"))).toBeNull();
  });
  it("Text ohne medizinische Angaben", () => {
    const t = offerText({ name: "Praxis", phone: "030 1" }, "Erika", slot.startsAt, "https://x/portal/angebot/abc", now);
    expect(t.body).toContain("05.03.2030 um 10:00 Uhr");
    expect(t.body).toContain("https://x/portal/angebot/abc");
    expect(t.body).not.toMatch(/Komplex|Behandlung|Spange/);
  });
});
