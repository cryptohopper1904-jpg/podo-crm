import { describe, expect, it } from "vitest";
import { clampPosition, initialPosition, prefillFromHref } from "./calendar-dialog";

const vp = { width: 1280, height: 800 };
const win = { width: 560, height: 640 };

describe("clampPosition", () => {
  it("lässt Positionen im Fenster unverändert", () => {
    expect(clampPosition({ x: 300, y: 100 }, win, vp)).toEqual({ x: 300, y: 100 });
  });
  it("hält das Fenster ganz im sichtbaren Bereich, wenn es hineinpasst", () => {
    expect(clampPosition({ x: -200, y: -50 }, win, vp)).toEqual({ x: 8, y: 8 });
    expect(clampPosition({ x: 2000, y: 2000 }, win, vp)).toEqual({ x: 1280 - 560 - 8, y: 800 - 640 - 8 });
  });
  it("zu großes Fenster: Titelleiste bleibt erreichbar", () => {
    const small = { width: 400, height: 500 };
    const p = clampPosition({ x: 5000, y: 5000 }, win, small);
    expect(p.x).toBeLessThanOrEqual(400 - 160 - 8);
    expect(p.y).toBeLessThanOrEqual(500 - 48 - 8);
    expect(clampPosition({ x: -999, y: -999 }, win, small)).toEqual({ x: 8, y: 8 });
  });
  it("rundet auf ganze Pixel", () => {
    expect(clampPosition({ x: 10.6, y: 20.2 }, win, vp)).toEqual({ x: 11, y: 20 });
  });
});

describe("initialPosition", () => {
  it("rechts neben dem Klick, links davon wenn rechts kein Platz ist", () => {
    expect(initialPosition(vp, win, { x: 100, y: 300 })).toEqual({ x: 124, y: 144 });
    expect(initialPosition(vp, win, { x: 1000, y: 300 }).x).toBe(1000 - 560 - 24);
  });
  it("ohne Klick rechts oben, im Bild", () => {
    const p = initialPosition(vp, win);
    expect(p.x + win.width).toBeLessThanOrEqual(vp.width);
    expect(p.y).toBeGreaterThanOrEqual(8);
  });
});

describe("prefillFromHref", () => {
  it("liest Datum, Uhrzeit, Behandler:in", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(prefillFromHref(`/kalender/neu?datum=2026-11-16&zeit=09:15&behandler=${id}`)).toEqual({ date: "2026-11-16", time: "09:15", therapistId: id });
  });
  it("ignoriert ungültige Werte und fremde Pfade", () => {
    expect(prefillFromHref("/kalender/neu?datum=16.11.2026&zeit=25:00&dauer=3&behandler=x")).toEqual({});
    expect(prefillFromHref("/kalender?datum=2026-11-16")).toBeNull();
    expect(prefillFromHref("/kalender/neu/daten")).toBeNull();
  });
});
