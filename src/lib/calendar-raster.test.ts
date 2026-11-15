/**
 * Kalender-Raster (Einstellungen → Kalender): Maßstab, Rasterzeilen, freie Klickflächen und Einrasten beim Ziehen
 * für alle Rasterweiten 60/30/15/10/5 Minuten.
 */
import { describe, expect, it } from "vitest";
import { freeParts, gridScale, gridSlots, isSlotStep, mergeIntervals, SLOT_STEPS, type SlotStep } from "./calendar-grid";
import { dropStartMin, resizeDuration, snapMin } from "./calendar-dnd";

const RANGE = { startMin: 7 * 60, endMin: 20 * 60 };

describe("gridScale", () => {
  it("15 Minuten bleibt wie bisher: 16 px je Zeile, 64 px je Stunde", () => {
    expect(gridScale(15)).toEqual({ step: 15, hourPx: 64, rowPx: 16, pxPerMin: 64 / 60 });
    expect(gridScale()).toEqual(gridScale(15));
  });
  it.each([
    [60, 64, 64],
    [30, 64, 32],
    [15, 64, 16],
    [10, 96, 16],
    [5, 192, 16],
  ] as const)("%i Minuten: Stunde %i px, Zeile %i px (Zeile ≥ 16 px, Stunde ≥ 64 px)", (step, hourPx, rowPx) => {
    const s = gridScale(step);
    expect(s.hourPx).toBe(hourPx);
    expect(s.rowPx).toBeCloseTo(rowPx);
    expect(s.rowPx).toBeGreaterThanOrEqual(16);
    expect(s.hourPx).toBeGreaterThanOrEqual(64);
    expect(s.pxPerMin * 60).toBeCloseTo(hourPx);
  });
  it("Termine außerhalb des Rasters liegen genau an ihrer Uhrzeit (stetiger Maßstab)", () => {
    for (const step of SLOT_STEPS) {
      const { pxPerMin } = gridScale(step);
      // 10:20 bei Achsenbeginn 07:00 → 200 Minuten
      expect(200 * pxPerMin).toBeCloseTo((200 / 60) * gridScale(step).hourPx);
    }
  });
});

describe("isSlotStep", () => {
  it("nur die angebotenen Weiten", () => {
    for (const s of SLOT_STEPS) expect(isSlotStep(s)).toBe(true);
    for (const v of [0, 1, 20, 45, "15", null, undefined, 15.5]) expect(isSlotStep(v)).toBe(false);
  });
});

describe("gridSlots", () => {
  it.each(SLOT_STEPS.map((s) => [s]))("%i Minuten: Zeilen von 07:00 bis vor 20:00", (step) => {
    const slots = gridSlots(RANGE, step as SlotStep);
    expect(slots.length).toBe((13 * 60) / step);
    expect(slots[0]).toBe(420);
    expect(slots.at(-1)).toBe(1200 - step);
    expect(slots.every((m, i) => i === 0 || m - slots[i - 1] === step)).toBe(true);
  });
  it("Bereich nicht auf dem Raster: erste Zeile auf dem nächsten Rasterpunkt", () => {
    expect(gridSlots({ startMin: 430, endMin: 480 }, 15)).toEqual([435, 450, 465]);
  });
});

describe("mergeIntervals / freeParts", () => {
  it("fasst überlappende und angrenzende Zeiten zusammen", () => {
    expect(mergeIntervals([{ startMin: 600, endMin: 630 }, { startMin: 540, endMin: 560 }, { startMin: 620, endMin: 660 }, { startMin: 660, endMin: 670 }, { startMin: 700, endMin: 700 }])).toEqual([
      { startMin: 540, endMin: 560 },
      { startMin: 600, endMin: 670 },
    ]);
  });
  it("freie Teile einer Rasterzeile ohne Belegung", () => {
    expect(freeParts(600, 660, [])).toEqual([{ startMin: 600, endMin: 660 }]);
    // 60-min-Raster, 10:00–10:15 belegt → ab 10:15 anklickbar
    expect(freeParts(600, 660, [{ startMin: 600, endMin: 615 }])).toEqual([{ startMin: 615, endMin: 660 }]);
    // belegt in der Mitte
    expect(freeParts(600, 660, [{ startMin: 620, endMin: 640 }])).toEqual([
      { startMin: 600, endMin: 620 },
      { startMin: 640, endMin: 660 },
    ]);
    // ganz belegt
    expect(freeParts(600, 615, [{ startMin: 590, endMin: 700 }])).toEqual([]);
    // Termin endet 10:13 → Beginn auf 10:15 aufgerundet; Reste unter 5 Minuten fallen weg
    expect(freeParts(600, 660, [{ startMin: 560, endMin: 613 }])).toEqual([{ startMin: 615, endMin: 660 }]);
    expect(freeParts(600, 615, [{ startMin: 600, endMin: 612 }])).toEqual([]);
  });
});

describe("Ziehen im Raster", () => {
  it.each(SLOT_STEPS.map((s) => [s]))("%i Minuten: Start rastet auf das Raster ein", (step) => {
    const { pxPerMin } = gridScale(step as SlotStep);
    // Zeiger bei 10:22 (Achse ab 07:00), Griff am Terminanfang
    const start = dropStartMin({ offsetPx: 202 * pxPerMin, grabMin: 0, pxPerMin, rangeStart: 420, rangeEnd: 1200, durationMin: 45, step });
    expect(start % step).toBe(0);
    expect(Math.abs(start - 622)).toBeLessThanOrEqual(step / 2);
    expect(snapMin(622, step)).toBe(start);
  });
  it.each(SLOT_STEPS.map((s) => [s]))("%i Minuten: Dauer ändern endet auf dem Raster (mindestens ein Schritt)", (step) => {
    const { pxPerMin } = gridScale(step as SlotStep);
    // Termin ab 10:00, Zeiger bei 11:07
    const d = resizeDuration({ offsetPx: 247 * pxPerMin, pxPerMin, rangeStart: 420, startMin: 600, step });
    expect((600 + d) % step).toBe(0);
    expect(d).toBeGreaterThanOrEqual(step);
    // ganz nach oben gezogen → ein Rasterschritt
    expect(resizeDuration({ offsetPx: 0, pxPerMin, rangeStart: 420, startMin: 600, step })).toBe(step);
  });
});
