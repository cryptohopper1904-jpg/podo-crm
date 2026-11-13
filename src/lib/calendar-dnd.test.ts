import { describe, expect, it } from "vitest";
import { autoScrollDelta, columnIndexAt, dragLock, dropStartMin, durationOf, localSlotToUtc, moveLabel, moveLabelLong, moveToDay, realDuration, resizeDuration, resizeOnDay, snapMin } from "./calendar-dnd";
import { berlinParts } from "./calendar-grid";
import { berlinToUtc } from "./format";

const PX = 16 / 15; // wie im Kalender: 16 px je 15 Minuten

describe("Raster und Position (Ziehen in Tag/Woche)", () => {
  it("rundet auf das 15-Minuten-Raster", () => {
    expect(snapMin(607)).toBe(600);
    expect(snapMin(608)).toBe(615);
    expect(snapMin(52, 30)).toBe(60);
  });

  it("Zeigerposition → Startminute (mit Griffversatz, begrenzt auf die Zeitachse)", () => {
    const base = { pxPerMin: PX, rangeStart: 7 * 60, rangeEnd: 20 * 60, durationMin: 40 };
    // 3 h unter 07:00, Termin 10 min unterhalb des Anfangs gegriffen → 09:50 → Raster 09:45
    expect(dropStartMin({ ...base, offsetPx: 180 * PX, grabMin: 10 })).toBe(9 * 60 + 45);
    expect(dropStartMin({ ...base, offsetPx: 183 * PX, grabMin: 10 })).toBe(10 * 60);
    // oberhalb der Zeitachse → Anfang; unterhalb → so, dass der Termin noch hineinpasst
    expect(dropStartMin({ ...base, offsetPx: -50, grabMin: 0 })).toBe(7 * 60);
    expect(dropStartMin({ ...base, offsetPx: 99_999, grabMin: 0 })).toBe(20 * 60 - 40);
  });

  it("Dauer ändern am unteren Rand: mindestens 15 min, höchstens 8 h, nicht über Mitternacht", () => {
    const base = { pxPerMin: PX, rangeStart: 7 * 60, startMin: 10 * 60 };
    expect(resizeDuration({ ...base, offsetPx: (3 * 60 + 50) * PX })).toBe(45); // 10:50 → 10:45
    expect(resizeDuration({ ...base, offsetPx: 0 })).toBe(15);
    expect(resizeDuration({ ...base, offsetPx: 99_999 })).toBe(480);
    expect(resizeDuration({ pxPerMin: PX, rangeStart: 0, startMin: 23 * 60, offsetPx: 99_999 })).toBe(60);
  });

  it("Spaltenwechsel: Spalte unter dem Zeiger", () => {
    const cols = [
      { left: 52, right: 180 },
      { left: 180, right: 308 },
      { left: 308, right: 436 },
    ];
    expect(columnIndexAt(cols, 60)).toBe(0);
    expect(columnIndexAt(cols, 180)).toBe(1); // Grenze gehört zur rechten Spalte
    expect(columnIndexAt(cols, 435.9)).toBe(2);
    expect(columnIndexAt(cols, 20)).toBe(-1); // Zeitachse
    expect(columnIndexAt(cols, 500)).toBe(-1);
  });

  it("Rand-Scrollen nur nahe am Rand", () => {
    expect(autoScrollDelta(300, 0, 600)).toBe(0);
    expect(autoScrollDelta(10, 0, 600)).toBeLessThan(0);
    expect(autoScrollDelta(595, 0, 600)).toBeGreaterThan(0);
    expect(autoScrollDelta(-100, 0, 600)).toBe(-18); // gedeckelt
    expect(autoScrollDelta(5, 0, 100)).toBe(0); // zu kleiner Bereich
  });
});

describe("Zeitpunkte (Berliner Ortszeit, Sommer-/Winterzeit)", () => {
  it("Slot → UTC an normalen Tagen (Winter +1, Sommer +2)", () => {
    expect(localSlotToUtc("2026-01-13", 10 * 60 + 30)!.toISOString()).toBe("2026-01-13T09:30:00.000Z");
    expect(localSlotToUtc("2026-07-14", 10 * 60 + 30)!.toISOString()).toBe("2026-07-14T08:30:00.000Z");
  });

  it("Umstellung auf Sommerzeit: 02:00–03:00 gibt es nicht", () => {
    expect(localSlotToUtc("2026-03-29", 2 * 60 + 30)).toBeNull();
    expect(localSlotToUtc("2026-03-29", 1 * 60 + 45)!.toISOString()).toBe("2026-03-29T00:45:00.000Z");
    expect(localSlotToUtc("2026-03-29", 3 * 60)!.toISOString()).toBe("2026-03-29T01:00:00.000Z");
    // echte Dauer bleibt: 60 min ab 01:30 enden um 03:30 Sommerzeit
    const s = localSlotToUtc("2026-03-29", 90)!;
    expect(moveLabel(s, new Date(s.getTime() + 60 * 60_000))).toBe("So 01:30–03:30");
  });

  it("Umstellung auf Winterzeit: 10:00 am Umstellungstag ist eindeutig", () => {
    const s = localSlotToUtc("2026-10-25", 10 * 60)!;
    expect(s.toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(berlinParts(s)).toEqual({ dateIso: "2026-10-25", min: 600 });
  });

  it("Dauer am Umstellungstag in echten Minuten (Ziehen am unteren Rand)", () => {
    expect(realDuration("2026-03-29", 60, 240)).toBe(120); // 01:00–04:00 Sommerzeit-Beginn: 2 h
    expect(realDuration("2026-10-25", 60, 240)).toBe(240); // 01:00–04:00 Winterzeit-Beginn: 4 h
    expect(realDuration("2026-06-10", 600, 645)).toBe(45);
    expect(realDuration("2026-03-29", 60, 150)).toBe(90); // Ende in der Lücke → Uhrzeit-Differenz
  });

  it("Dauer ziehen am Winterzeit-Tag: echte Dauer höchstens 8 h", () => {
    const base = { pxPerMin: PX, rangeStart: 0, startMin: 0, offsetPx: 99_999 };
    // 00:00–08:00 Uhr sind am 25.10.2026 neun echte Stunden → auf 00:00–07:00 (8 h) begrenzt
    expect(resizeOnDay({ ...base, dateIso: "2026-10-25" })).toEqual({ localMin: 420, realMin: 480 });
    expect(resizeOnDay({ ...base, dateIso: "2026-03-29" })).toEqual({ localMin: 480, realMin: 420 });
    expect(resizeOnDay({ ...base, dateIso: "2026-06-10", offsetPx: 45 * PX })).toEqual({ localMin: 45, realMin: 45 });
  });

  it("Beginn in der doppelten Stunde (25.10., 02:30 zweimal): echte Dauer ab dem tatsächlichen Beginn", () => {
    const base = { dateIso: "2026-10-25", pxPerMin: PX, rangeStart: 0, startMin: 150 };
    const first = new Date("2026-10-25T00:30:00Z"); // 02:30 Sommerzeit
    const second = new Date("2026-10-25T01:30:00Z"); // 02:30 Winterzeit
    // bis 03:30 Uhr: vom ersten 02:30 zwei echte Stunden, vom zweiten eine
    expect(resizeOnDay({ ...base, offsetPx: 210 * PX, startsAt: first })).toEqual({ localMin: 60, realMin: 120 });
    expect(resizeOnDay({ ...base, offsetPx: 210 * PX, startsAt: second })).toEqual({ localMin: 60, realMin: 60 });
    // Ende ebenfalls in der doppelten Stunde: frühestes 02:45 nach dem Beginn
    expect(resizeOnDay({ ...base, offsetPx: 165 * PX, startsAt: first })).toEqual({ localMin: 15, realMin: 15 });
    expect(resizeOnDay({ ...base, offsetPx: 165 * PX, startsAt: second })).toEqual({ localMin: 15, realMin: 15 });
    // 8-h-Grenze ab dem ersten 02:30: höchstens 7 Uhr-Stunden (= 8 echte)
    expect(resizeOnDay({ ...base, offsetPx: 99_999, startsAt: first })).toEqual({ localMin: 420, realMin: 480 });
    expect(resizeOnDay({ ...base, offsetPx: 99_999, startsAt: second })).toEqual({ localMin: 480, realMin: 480 });
  });

  it("Monatsansicht: anderer Tag, gleiche Uhrzeit – auch über die Zeitumstellung", () => {
    const winter = berlinToUtc("2026-03-27", "10:30"); // Fr, UTC+1
    const moved = moveToDay(winter, "2026-03-31")!; // Di, UTC+2
    expect(moved.toISOString()).toBe("2026-03-31T08:30:00.000Z");
    expect(berlinParts(moved).min).toBe(10 * 60 + 30);
    expect(moveToDay(berlinToUtc("2026-03-28", "02:15"), "2026-03-29")).toBeNull();
  });

  it("Anzeige im Geisterbild und Ansage", () => {
    const s = berlinToUtc("2026-11-17", "10:30");
    const e = new Date(s.getTime() + 40 * 60_000);
    expect(moveLabel(s, e)).toBe("Di 10:30–11:10");
    expect(moveLabelLong(s, e)).toBe("Di 17.11. 10:30–11:10 Uhr");
    expect(moveLabel(berlinToUtc("2026-11-17", "23:30"), berlinToUtc("2026-11-18", "00:30"))).toBe("Di 23:30–Mi 00:30");
    expect(durationOf(s, e)).toBe(40);
  });
});

describe("Was darf gezogen werden?", () => {
  const base = { source: "phone", status: "planned", therapistId: "t1", startsAt: new Date("2026-11-17T09:00:00Z"), endsAt: new Date("2026-11-17T09:30:00Z"), fromCalendarFeed: false, billed: false };
  it("geplante und bestätigte Termine: ja", () => {
    expect(dragLock(base)).toBeNull();
    expect(dragLock({ ...base, status: "confirmed" })).toBeNull();
  });
  it("abgesagt, erledigt, nicht erschienen, sehr kurz, abgerechnet, Doctolib/Kalender-Abo, ohne Behandler:in, sehr lang: nein (mit Hinweis)", () => {
    expect(dragLock({ ...base, status: "cancelled" })).toMatch(/Abgesagte/);
    expect(dragLock({ ...base, status: "done" })).toMatch(/Erledigte/);
    expect(dragLock({ ...base, status: "no_show" })).toMatch(/Nicht erschienene/);
    expect(dragLock({ ...base, endsAt: new Date("2026-11-17T09:04:00Z") })).toMatch(/kurze/);
    expect(dragLock({ ...base, endsAt: new Date("2026-11-17T09:05:00Z") })).toBeNull();
    expect(dragLock({ ...base, billed: true })).toMatch(/abgerechnet/);
    expect(dragLock({ ...base, source: "doctolib" })).toMatch(/Doctolib/);
    expect(dragLock({ ...base, fromCalendarFeed: true })).toMatch(/Kalender-Abo/);
    expect(dragLock({ ...base, therapistId: null })).toMatch(/ohne Behandler/);
    expect(dragLock({ ...base, endsAt: new Date("2026-11-17T18:00:00Z") })).toMatch(/lange/);
  });
});
