import { describe, expect, it } from "vitest";
import { archivedCodeCandidates, isArchivedCode, restoredCode } from "./service-codes";

describe("Kürzel archivierter Leistungen", () => {
  it("AN → AN_archiv, bei Kollision AN_archiv2 …; Wiederherstellen nimmt den Zusatz ab", () => {
    expect(archivedCodeCandidates("AN").slice(0, 3)).toEqual(["AN_archiv", "AN_archiv2", "AN_archiv3"]);
    // schon archiviertes Kürzel wird nicht doppelt ergänzt
    expect(archivedCodeCandidates("AN_archiv2")[0]).toBe("AN_archiv");
    expect(restoredCode("AN_archiv")).toBe("AN");
    expect(restoredCode("AN_archiv12")).toBe("AN");
    expect(restoredCode("ARCHIV")).toBe("ARCHIV");
    expect(isArchivedCode("PK_archiv3")).toBe(true);
    expect(isArchivedCode("PK")).toBe(false);
  });
});
