import { describe, expect, it } from "vitest";
import { archivedCodeCandidates, isArchivedCode, isUsableCode, MAX_ARCHIVED_CODES, moveServiceCodeRefs, restoredCode } from "./service-codes";

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
    // Groß-/Kleinschreibung egal (Formular schreibt groß: „AN_ARCHIV“ zählt als Archiv-Kürzel)
    expect(isArchivedCode("AN_ARCHIV2")).toBe(true);
  });

  it("zurückgewonnenes Kürzel taugt nur mit 1–10 Zeichen und ohne Archiv-Zusatz", () => {
    expect(isUsableCode("AN")).toBe(true);
    expect(isUsableCode("ABCDEFGHIJ")).toBe(true);
    expect(isUsableCode("")).toBe(false);
    expect(isUsableCode("   ")).toBe(false);
    expect(isUsableCode("ABCDEFGHIJK")).toBe(false);
    expect(isUsableCode("AN_archiv")).toBe(false);
  });
});

describe("Verweise per Kürzel (organizations.settings) wandern mit", () => {
  const settings = {
    onlineBooking: { enabled: true, serviceCodes: ["AN", "PK"], leadHours: 4 },
    voice: { storeTranscripts: true, serviceCodes: ["AN"] },
    website: { enabled: true, claim: "x", serviceDescriptions: { AN: "Erstgespräch", PK: "Komplex" } },
    servicePriceNotes: { AN: "Preis bitte prüfen" },
    other: { AN: 1 },
  };

  it("Archivieren: AN → AN_archiv in Listen und Beschreibungen, übrige Einstellungen unverändert", () => {
    expect(moveServiceCodeRefs(settings, "AN", "AN_archiv")).toEqual({
      onlineBooking: { enabled: true, serviceCodes: ["AN_archiv", "PK"], leadHours: 4 },
      voice: { storeTranscripts: true, serviceCodes: ["AN_archiv"] },
      website: { enabled: true, claim: "x", serviceDescriptions: { PK: "Komplex", AN_archiv: "Erstgespräch" } },
      servicePriceNotes: { AN_archiv: "Preis bitte prüfen" },
    });
  });

  it("Wiederherstellen: zurück; doppelte Einträge entfallen", () => {
    const s = { onlineBooking: { serviceCodes: ["AN_archiv", "AN"] } };
    expect(moveServiceCodeRefs(s, "AN_archiv", "AN")).toEqual({ onlineBooking: { serviceCodes: ["AN"] } });
  });

  it("Neue Leistung mit freigewordenem Kürzel erbt nichts – Listen werden dabei nie leer (leer = alle buchbar)", () => {
    expect(moveServiceCodeRefs(settings, "AN", null)).toEqual({
      onlineBooking: { enabled: true, serviceCodes: ["PK"], leadHours: 4 },
      website: { enabled: true, claim: "x", serviceDescriptions: { PK: "Komplex" } },
      servicePriceNotes: {},
    });
  });

  it("Keine Verweise → null; fehlerhafte Formen werden ignoriert", () => {
    expect(moveServiceCodeRefs(settings, "XY", "XY_archiv")).toBeNull();
    expect(moveServiceCodeRefs({}, "AN", "AN_archiv")).toBeNull();
    expect(moveServiceCodeRefs(null, "AN", "AN_archiv")).toBeNull();
    expect(moveServiceCodeRefs({ onlineBooking: { serviceCodes: "AN" }, website: [], servicePriceNotes: "AN" }, "AN", "B")).toBeNull();
  });

  it("höchstens 99 Archiv-Kürzel je Ausgangskürzel", () => {
    expect(archivedCodeCandidates("AN")).toHaveLength(MAX_ARCHIVED_CODES);
    expect(archivedCodeCandidates("AN").at(-1)).toBe("AN_archiv99");
  });
});
