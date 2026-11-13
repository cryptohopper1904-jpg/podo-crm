import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEEK,
  emptyWeek,
  groupWeek,
  openingSpeech,
  openingSummary,
  practiceHours,
  storedPracticeHours,
  sameWeek,
  validateWeek,
  weekFromList,
  weekSpeech,
  weekSummary,
  weekToList,
  weekdaysWeek,
} from "./opening-hours";
import { openingHours, websiteOpeningHours, websiteSettings } from "./website";

const h = (weekday: number, from: string, to: string) => ({ weekday, from, to });

describe("Öffnungszeiten lesen (rückwärtskompatibel)", () => {
  it("ohne Angaben: Mo–Fr 08:00–18:00, Sa/So geschlossen", () => {
    expect(practiceHours({})).toEqual(DEFAULT_WEEK);
    expect(practiceHours(null)[1]).toEqual([{ start: "08:00", end: "18:00" }]);
    expect(practiceHours(undefined)[6]).toEqual([]);
  });
  it("Altdaten settings.opening → Mo–Fr gleiche Zeiten", () => {
    const w = practiceHours({ opening: { from: "07:30", to: "16:00" } });
    expect(w).toEqual(weekdaysWeek({ start: "07:30", end: "16:00" }));
    expect(w[7]).toEqual([]);
    // teilweise Angaben wie bisher mit Standardwert ergänzt; unlesbarer Bereich = keine Öffnungszeit (wie zuvor)
    expect(practiceHours({ opening: { from: "09:00" } })[3]).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(practiceHours({ opening: { from: "18:00", to: "08:00" } })).toEqual(emptyWeek());
  });
  it("practiceHours hat Vorrang vor opening; leere Liste = alle Tage geschlossen", () => {
    expect(practiceHours({ practiceHours: [h(6, "09:00", "12:00")], opening: { from: "08:00", to: "18:00" } })).toEqual({ ...emptyWeek(), 6: [{ start: "09:00", end: "12:00" }] });
    expect(practiceHours({ practiceHours: [] })).toEqual(emptyWeek());
  });
  it("tolerant: ungültige Einträge verworfen, je Tag sortiert und verschmolzen", () => {
    const w = weekFromList([h(1, "13:00", "18:00"), h(1, "08:00", "12:00"), h(1, "11:00", "12:30"), h(8, "08:00", "09:00"), h(2, "12:00", "08:00"), h(3, "8:00", "9:00"), null, "x"]);
    expect(w[1]).toEqual([{ start: "08:00", end: "12:30" }, { start: "13:00", end: "18:00" }]);
    expect(w[2]).toEqual([]);
    expect(w[3]).toEqual([]);
    expect(weekToList(w)).toEqual([h(1, "08:00", "12:30"), h(1, "13:00", "18:00")]);
  });
});

describe("Öffnungszeiten prüfen (Eingabe)", () => {
  it("gültig: Mittagspause, Samstag, angrenzende Fenster", () => {
    const v = validateWeek([h(1, "13:00", "18:00"), h(1, "08:00", "12:00"), h(6, "09:00", "12:00"), h(2, "08:00", "12:00"), h(2, "12:00", "14:00")]);
    expect(v.error).toBeUndefined();
    expect(v.week![1]).toEqual([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }]);
    expect(v.week![7]).toEqual([]);
    expect(validateWeek([]).week).toEqual(emptyWeek());
  });
  it("von muss vor bis liegen", () => {
    expect(validateWeek([h(3, "12:00", "12:00")]).error).toMatch(/Mittwoch.*„bis“ \(12:00\) muss nach „von“ \(12:00\)/);
    expect(validateWeek([h(3, "14:00", "09:00")]).error).toMatch(/Mittwoch/);
  });
  it("keine Überschneidungen", () => {
    expect(validateWeek([h(1, "08:00", "12:00"), h(1, "11:30", "18:00")]).error).toMatch(/Montag: 08:00–12:00 und 11:30–18:00 überschneiden sich/);
    expect(validateWeek([h(1, "08:00", "18:00"), h(1, "10:00", "11:00")]).error).toMatch(/überschneiden/);
  });
  it("5-Minuten-Raster, Uhrzeitformat, Wochentag, Anzahl", () => {
    expect(validateWeek([h(1, "08:03", "12:00")]).error).toMatch(/5-Minuten-Raster/);
    expect(validateWeek([h(1, "8:00", "12:00")]).error).toMatch(/Uhrzeit/);
    expect(validateWeek([h(1, "", "12:00")]).error).toMatch(/Uhrzeit/);
    expect(validateWeek([h(1, "24:00", "25:00")]).error).toMatch(/Uhrzeit/);
    expect(validateWeek([h(0, "08:00", "12:00")]).error).toMatch(/Wochentag/);
    expect(validateWeek([h(1.5, "08:00", "12:00")]).error).toMatch(/Wochentag/);
    expect(validateWeek({ 1: [] }).error).toBeTruthy();
    expect(validateWeek([h(5, "07:00", "08:00"), h(5, "08:00", "09:00"), h(5, "09:00", "10:00"), h(5, "10:00", "11:00"), h(5, "11:00", "12:00")]).error).toMatch(/Freitag: höchstens 4/);
  });
});

describe("Öffnungszeiten anzeigen", () => {
  const week = weekFromList([...[1, 2, 3, 4, 5].flatMap((d) => [h(d, "08:00", "12:00"), h(d, "13:00", "18:00")]), h(6, "09:00", "12:00")]);
  it("fasst gleiche Folgetage zusammen", () => {
    expect(groupWeek(week).map((g) => [g.from, g.to])).toEqual([[1, 5], [6, 6], [7, 7]]);
    expect(weekSummary(week)).toBe("Mo–Fr 08:00–12:00, 13:00–18:00 · Sa 09:00–12:00 · So geschlossen");
    expect(weekSummary(emptyWeek())).toBe("keine Öffnungszeiten hinterlegt");
  });
  it("gesprochene Form für das KI-Telefon", () => {
    expect(weekSpeech(week)).toBe("Montag bis Freitag 08:00 bis 12:00 Uhr und 13:00 bis 18:00 Uhr; Samstag 09:00 bis 12:00 Uhr; Sonntag geschlossen");
    expect(weekSpeech(DEFAULT_WEEK)).toBe("Montag bis Freitag 08:00 bis 18:00 Uhr; Samstag und Sonntag geschlossen");
  });
  it("vergleicht Wochen", () => {
    expect(sameWeek(week, weekFromList(weekToList(week)))).toBe(true);
    expect(sameWeek(week, DEFAULT_WEEK)).toBe(false);
  });
});

describe("Website-Zeiten: Standard = Praxis-Öffnungszeiten", () => {
  it("ohne eigene Website-Zeiten die Praxis-Öffnungszeiten", () => {
    const s = { practiceHours: [h(2, "08:00", "12:00"), h(2, "13:00", "17:00")] };
    expect(websiteSettings(s).customHours).toBe(false);
    expect(websiteOpeningHours(s)).toEqual([h(2, "08:00", "12:00"), h(2, "13:00", "17:00")]);
    expect(websiteOpeningHours({ opening: { from: "09:00", to: "17:00" } })).toHaveLength(5);
  });
  it("Praxis ohne gepflegte Zeiten: Website zeigt KEINE Zeiten (intern Mo–Fr 08–18)", () => {
    expect(storedPracticeHours({})).toBeNull();
    expect(websiteOpeningHours({})).toEqual([]);
    expect(websiteOpeningHours({ website: { enabled: true } })).toEqual([]);
    expect(practiceHours({})).toEqual(DEFAULT_WEEK);
  });
  it("Altdaten: Website-Zeiten (Bootstrap) sind die Praxis-Öffnungszeiten, nicht opening auf Mo–Fr gespreizt", () => {
    const s = { opening: { from: "08:00", to: "17:00" }, openingHours: [h(2, "08:00", "17:00"), h(3, "08:00", "17:00")] };
    expect(websiteSettings(s).customHours).toBe(false);
    expect(weekToList(practiceHours(s))).toEqual(s.openingHours);
    expect(websiteOpeningHours(s)).toEqual(s.openingHours);
  });
  it("eigene Website-Zeiten mit Schalter; leere eigene Woche = alle Tage geschlossen", () => {
    const own = [h(3, "08:00", "17:00")];
    expect(websiteOpeningHours({ openingHours: own, practiceHours: [h(1, "08:00", "18:00")], website: { customHours: true } })).toEqual(own);
    expect(websiteOpeningHours({ openingHours: own, practiceHours: [h(1, "08:00", "18:00")], website: { customHours: false } })).toEqual([h(1, "08:00", "18:00")]);
    expect(websiteOpeningHours({ openingHours: [], practiceHours: [h(1, "08:00", "18:00")], website: { customHours: true } })).toEqual([]);
  });
  it("Altzeiten außerhalb des 5-Minuten-Rasters werden eingerastet (von ab-, bis aufgerundet)", () => {
    const s = { openingHours: [h(1, "08:03", "12:01"), h(2, "07:59", "23:58")] };
    expect(openingHours(s)).toEqual([h(1, "08:00", "12:05"), h(2, "07:55", "23:55")]);
    expect(weekToList(practiceHours(s))).toEqual([h(1, "08:00", "12:05"), h(2, "07:55", "23:55")]);
    expect(validateWeek(weekToList(practiceHours(s))).error).toBeUndefined();
    expect(practiceHours({ opening: { from: "07:32", to: "16:58" } })[1]).toEqual([{ start: "07:30", end: "17:00" }]);
  });
  it("Telefon-Ansage ohne Zeiten erfindet nichts", () => {
    expect(openingSpeech({})).toBe("Feste Öffnungszeiten sind derzeit nicht hinterlegt.");
    expect(openingSpeech({ practiceHours: [] })).toBe("Feste Öffnungszeiten sind derzeit nicht hinterlegt.");
    expect(openingSpeech({ practiceHours: [h(1, "08:00", "12:00")] })).toBe("Montag 08:00 bis 12:00 Uhr; Dienstag bis Sonntag geschlossen; an gesetzlichen Feiertagen geschlossen");
    expect(openingSummary({})).toBeNull();
  });
});
