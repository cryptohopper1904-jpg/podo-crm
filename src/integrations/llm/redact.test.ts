import { describe, expect, it } from "vitest";
import { redact, restore } from "./redact";

describe("redact", () => {
  it("entfernt E-Mail, Telefon, Datum und bekannte Namen", () => {
    const input =
      "Hallo, hier ist Erika Beispiel (geb. 01.02.1950). Erika erreichen Sie unter 0171 1234567 oder erika@example.org.";
    const { text, map } = redact(input, { names: ["Erika Beispiel", "Erika", "Beispiel"] });
    expect(text).not.toContain("Erika");
    expect(text).not.toContain("0171");
    expect(text).not.toContain("example.org");
    expect(text).not.toContain("1950");
    expect(text).toContain("[NAME_1]");
    expect(text).toContain("[TELEFON_1]");
    expect(text).toContain("[EMAIL_1]");
    expect(text).toContain("[DATUM_1]");
    expect(restore(text, map)).toBe(input);
  });

  it("lässt Fachinhalt und kurze Zahlen unverändert", () => {
    const input = "Nagel D1 links verdickt, 2 Spangen, Kontrolle in 4 Wochen.";
    expect(redact(input).text).toBe(input);
  });

  it("behält Datumsangaben auf Wunsch", () => {
    expect(redact("Termin am 12.03.2026", { keepDates: true }).text).toBe("Termin am 12.03.2026");
  });

  it("ersetzt KVNR und IBAN", () => {
    const { text } = redact("KVNR A123456789, IBAN DE89 3704 0044 0532 0130 00");
    expect(text).toBe("KVNR [KVNR_1], IBAN [IBAN_1]");
  });
});
