/**
 * „Heute“ = Berliner Kalendertag, auch kurz nach Berliner Mitternacht (23:30 UTC = 00:30 Berlin, Winter;
 * 22:30 UTC = 00:30 Berlin, Sommer). Erfundene Daten.
 */
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampDurationMin } from "./appointment-duration";
import { parseWorkbook } from "./import/excel/parse";
import { mediaPath } from "./practice-export";
import { mockSuggestionJson } from "@/integrations/ocr/ocr";

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
afterEach(() => vi.useRealTimers());

async function voucherWithoutDate(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const g = wb.addWorksheet("Gutscheine");
  g.addRow(["ID", "Gutscheinnummer", "Datum", "Gültig bis", "Betrag", "Restbetrag", "Hinweis"]);
  g.addRow([1, "G-TEST-1", null, null, 20, 20, null]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("Berliner „heute“ nach Mitternacht", () => {
  for (const [now, today] of [
    ["2026-11-13T23:30:00Z", "2026-11-14"], // Winter: UTC noch 13.11.
    ["2026-07-14T22:30:00Z", "2026-07-15"], // Sommer: UTC noch 14.07.
    ["2026-11-13T22:30:00Z", "2026-11-13"], // Winter, Berlin 23:30 – noch derselbe Tag
  ] as const) {
    it(`Excel-Import: fehlendes Gutscheindatum = Importtag in Berlin (${now})`, async () => {
      at(now);
      const res = await parseWorkbook(await voucherWithoutDate());
      expect(res.vouchers[0]).toMatchObject({ code: "G-TEST-1", issuedAt: today });
    });
  }

  it("Praxis-Export: Foto-Datum im Dateinamen ist der Berliner Aufnahmetag", () => {
    expect(mediaPath({ id: "abcdef12-3456", mime: "image/jpeg", purpose: "before", takenAt: new Date("2026-11-13T23:30:00Z") }, 17)).toBe("media/17/2026-11-14_before_abcdef12.jpg");
    expect(mediaPath({ id: "abcdef12-3456", mime: "image/jpeg", purpose: "before", takenAt: "2026-07-14T22:30:00Z" }, 17)).toBe("media/17/2026-07-15_before_abcdef12.jpg");
  });

  it("OCR-Testmodus: Ausstellungsdatum zwei Berliner Tage zurück", () => {
    expect(JSON.parse(mockSuggestionJson(new Date("2026-11-13T23:30:00Z"))).fields.issuedAt.value).toBe("2026-11-12");
  });
});

describe("clampDurationMin", () => {
  it("begrenzt auf 5–480 Minuten, ganzzahlig, ungültig → 30", () => {
    expect([600, 480, 479.6, 45, 5, 4, 0, -10].map(clampDurationMin)).toEqual([480, 480, 480, 45, 5, 5, 5, 5]);
    expect(clampDurationMin(Number.NaN)).toBe(30);
    expect(clampDurationMin(Number.POSITIVE_INFINITY)).toBe(30);
  });
});
