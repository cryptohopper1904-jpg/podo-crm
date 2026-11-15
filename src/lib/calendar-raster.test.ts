/**
 * Kalender-Raster (Einstellungen → Kalender): Maßstab, Rasterzeilen, freie Klickflächen und Einrasten beim Ziehen
 * für alle Rasterweiten 60/30/15/10/5 Minuten.
 */
import { describe, expect, it } from "vitest";
import { freeParts, gridScale, gridSlots, isSlotStep, mergeIntervals, minFreeMin, SLOT_STEPS, type SlotStep } from "./calendar-grid";
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

describe("freie Reststücke antippbar", () => {
  it.each(SLOT_STEPS.map((s) => [s]))("%i Minuten: Klickfläche mindestens 10 px hoch", (step) => {
    const scale = gridScale(step as SlotStep);
    const min = minFreeMin(scale);
    expect(min * scale.pxPerMin).toBeGreaterThanOrEqual(10);
    expect(min).toBeGreaterThanOrEqual(5);
    // 15-Minuten-Raster: 5-Minuten-Rest (5 px) fällt weg, 10 Minuten bleiben
    if (step === 15) {
      expect(freeParts(600, 615, [{ startMin: 600, endMin: 610 }], min)).toEqual([]);
      expect(freeParts(600, 615, [{ startMin: 600, endMin: 605 }], min)).toEqual([{ startMin: 605, endMin: 615 }]);
    }
  });
});

describe("Ziehen im Raster", () => {
  it.each(SLOT_STEPS.map((s) => [s]))("%i Minuten: Verschiebung rastet ein (Termin auf dem Raster bleibt auf dem Raster)", (step) => {
    const { pxPerMin } = gridScale(step as SlotStep);
    // Termin 10:00, Zeiger bei 10:22 (Achse ab 07:00), Griff am Terminanfang
    const start = dropStartMin({ offsetPx: 202 * pxPerMin, grabMin: 0, pxPerMin, rangeStart: 420, rangeEnd: 1200, durationMin: 45, originMin: 600, step });
    expect(start % step).toBe(0);
    expect(Math.abs(start - 622)).toBeLessThanOrEqual(step / 2);
    expect(snapMin(622, step)).toBe(start);
  });

  it.each([[60], [30]])("%i Minuten: Termin außerhalb des Rasters (10:30 bzw. 10:10) behält seine Minuten", (step) => {
    const { pxPerMin } = gridScale(step as SlotStep);
    const base = { grabMin: 5, pxPerMin, rangeStart: 420, rangeEnd: 1200, durationMin: 45, step };
    const at = (origin: number, pointerMin: number) => dropStartMin({ ...base, originMin: origin, offsetPx: (pointerMin - 420) * pxPerMin });
    // nur in eine andere Spalte gezogen (Zeiger auf gleicher Höhe, Griff 5 min unter dem Anfang) → Uhrzeit bleibt
    expect(at(630, 635)).toBe(630);
    expect(at(610, 615)).toBe(610);
    // kleine Bewegung unter einem halben Rasterschritt → bleibt
    expect(at(630, 635 + step / 2 - 1)).toBe(630);
    // ein Rasterschritt nach unten bzw. oben → genau ein Schritt, Minuten bleiben
    expect(at(630, 635 + step)).toBe(630 + step);
    expect(at(630, 635 - step + 4)).toBe(630 - step);
    expect(at(610, 615 + 2 * step - 3)).toBe(610 + 2 * step);
    // Rand der Zeitachse begrenzt weiterhin
    expect(at(630, 0)).toBe(420);
  });

  it.each(SLOT_STEPS.map((s) => [s]))("%i Minuten: Dauer ändert sich in Schritten von höchstens 15 Minuten, mindestens 5 Minuten", (step) => {
    const { pxPerMin } = gridScale(step as SlotStep);
    const d = Math.min(step, 15);
    // Termin 10:00–10:45, Zeiger bei 11:07
    const dur = resizeDuration({ offsetPx: 247 * pxPerMin, pxPerMin, rangeStart: 420, startMin: 600, durationMin: 45, step });
    expect((dur - 45) % d).toBe(0);
    expect(Math.abs(600 + dur - 667)).toBeLessThanOrEqual(d / 2);
    // ganz nach oben gezogen → Mindestdauer 5 Minuten (unabhängig vom Raster)
    expect(resizeDuration({ offsetPx: 0, pxPerMin, rangeStart: 420, startMin: 600, durationMin: 45, step })).toBe(5);
  });

  it.each([[60], [30]])("%i Minuten: Dauer eines Termins außerhalb des Rasters (10:30–11:10) bleibt „krumm“", (step) => {
    const { pxPerMin } = gridScale(step as SlotStep);
    const base = { pxPerMin, rangeStart: 420, startMin: 630, durationMin: 40, step };
    const at = (pointerMin: number) => resizeDuration({ ...base, offsetPx: (pointerMin - 420) * pxPerMin });
    expect(at(670)).toBe(40); // Rand nicht bewegt
    expect(at(686)).toBe(55); // +16 min → +15
    expect(at(640)).toBe(10); // −30 min
    expect(at(600)).toBe(5); // weit nach oben → Mindestdauer
  });
});
