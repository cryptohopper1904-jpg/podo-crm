import { describe, expect, it } from "vitest";
import { mayQuickReload, parseReloadHistory, QUICK_DELAYS_MS, QUICK_RELOADS, QUICK_WINDOW_MS, quickProbeDelay } from "./offline-resume";

describe("Offline-Ersatzseite: Neuladen nach Wiederverbindung", () => {
  it("prüft zuerst sofort, dann mit wachsendem Abstand, dann nicht mehr schnell", () => {
    expect(quickProbeDelay(0)).toBe(0);
    const delays = QUICK_DELAYS_MS.map((_, i) => quickProbeDelay(i) ?? -1);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(quickProbeDelay(QUICK_DELAYS_MS.length)).toBeNull();
    expect(quickProbeDelay(-1)).toBeNull();
  });
  it("begrenzt schnelle Neuladungen je Zeitfenster (kein Neuladen im Sekundentakt)", () => {
    const now = 1_000_000;
    expect(mayQuickReload([], now)).toBe(true);
    const full = Array.from({ length: QUICK_RELOADS }, (_, i) => now - i * 1000);
    expect(mayQuickReload(full, now)).toBe(false);
    // ältere Einträge zählen nicht mehr
    expect(mayQuickReload(full.map((t) => t - QUICK_WINDOW_MS), now)).toBe(true);
  });
  it("liest den Verlauf fehlerfest", () => {
    const now = 1_000_000;
    expect(parseReloadHistory(null, now)).toEqual([]);
    expect(parseReloadHistory("kaputt", now)).toEqual([]);
    expect(parseReloadHistory('{"a":1}', now)).toEqual([]);
    expect(parseReloadHistory(JSON.stringify([now - 1000, now - QUICK_WINDOW_MS - 1, "x"]), now)).toEqual([now - 1000]);
  });
});
