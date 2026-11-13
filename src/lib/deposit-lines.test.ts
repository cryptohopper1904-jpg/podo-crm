import { describe, expect, it } from "vitest";
import { depositLineText } from "./deposit-lines";

describe("depositLineText", () => {
  it("lässt den Anzahlungs-Vorspann weg und behält das Behandlungsdatum", () => {
    expect(depositLineText({ description: "Anzahlung auf die Sammelrechnung 2026: Behandlung am 12.03.2026 (Podologische Komplexbehandlung)", issuedAt: "2026-03-12" })).toBe(
      "Behandlung am 12.03.2026 (Podologische Komplexbehandlung)",
    );
  });
  it("stellt das Quittungsdatum voran, wenn der Text keins enthält", () => {
    expect(depositLineText({ description: "Nagelkorrekturspange", issuedAt: "2026-05-04" })).toBe("04.05.2026: Nagelkorrekturspange");
    expect(depositLineText({ description: "Anzahlung:", issuedAt: "2026-05-04" })).toBe("04.05.2026: Behandlung");
  });
});
