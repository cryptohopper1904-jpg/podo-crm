import { describe, expect, it } from "vitest";
import { errorFromBody, filenameFromDisposition, handoverErrorText } from "./download";

describe("Erst-Export im Browser: Meldungen und Dateiname", () => {
  it("Meldung der Route hat Vorrang, sonst verständlicher Text je Status", () => {
    expect(handoverErrorText(409, "Das Übergabepaket wäre 60 MB groß")).toBe("Das Übergabepaket wäre 60 MB groß");
    expect(handoverErrorText(429, null)).toMatch(/Minute warten/);
    expect(handoverErrorText(403, "")).toMatch(/Kein Zugriff/);
    expect(handoverErrorText(409, undefined)).toMatch(/nicht erzeugt/);
    expect(handoverErrorText(500, null)).toMatch(/Fehler 500/);
    expect(handoverErrorText(409, "x".repeat(900))).toHaveLength(500);
  });

  it("errorFromBody liest nur { error: string }", () => {
    expect(errorFromBody({ error: "Bitte warten" })).toBe("Bitte warten");
    expect(errorFromBody({ error: 5 })).toBeNull();
    expect(errorFromBody(null)).toBeNull();
    expect(errorFromBody("Fehler")).toBeNull();
  });

  it("Dateiname aus Content-Disposition, unsichere Namen → Fallback", () => {
    expect(filenameFromDisposition('attachment; filename="Uebergabe-2026-11-19-1a2b3c4d.zip"')).toBe("Uebergabe-2026-11-19-1a2b3c4d.zip");
    expect(filenameFromDisposition('attachment; filename="../x.zip"')).toBe("Uebergabepaket.zip");
    expect(filenameFromDisposition(null)).toBe("Uebergabepaket.zip");
    expect(filenameFromDisposition("attachment")).toBe("Uebergabepaket.zip");
  });
});
