import { describe, expect, it } from "vitest";
import { mapPool, TimeoutError, withTimeout } from "./pool";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapPool / withTimeout", () => {
  it("höchstens `limit` Aufgaben gleichzeitig, Fehler bleiben isoliert, Reihenfolge stabil", async () => {
    let active = 0;
    let peak = 0;
    const res = await mapPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
      if (n === 3) throw new Error("kaputt");
      return n * 2;
    });
    expect(peak).toBe(5);
    expect(res[2]).toMatchObject({ status: "rejected" });
    expect(res.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<number>).value)).toEqual([2, 4, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
    expect(await mapPool([], 5, async () => 1)).toEqual([]);
  });

  it("hängende Aufgabe läuft in das Zeitlimit, andere sind nicht blockiert", async () => {
    const t0 = Date.now();
    const res = await mapPool(["hängt", "a", "b"], 2, (x) => withTimeout(x === "hängt" ? new Promise<string>(() => {}) : sleep(5).then(() => x), 50, "zu langsam"));
    expect(res[0]).toMatchObject({ status: "rejected", reason: expect.any(TimeoutError) });
    expect(res.slice(1)).toEqual([{ status: "fulfilled", value: "a" }, { status: "fulfilled", value: "b" }]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
