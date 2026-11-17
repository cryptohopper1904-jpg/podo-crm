import { describe, expect, it } from "vitest";
import { bsnrProblem, ikProblem, isValidIk, isValidKvnr, isValidLanr, kvnrCheckDigit, lanrCheckDigit, lanrProblem, parseInsuredStatus, providerStatusOf } from "./gkv-ids";

describe("Institutionskennzeichen", () => {
  it("Rechenbeispiel aus Anlage 1 der KVNR-Richtlinie (IK 109911114)", () => {
    expect(isValidIk("109911114")).toBe(true);
    expect(isValidIk("109911115")).toBe(false);
  });
  it("Klassifikation (Stellen 1–2) zählt nicht", () => {
    expect(isValidIk("209911114")).toBe(true);
  });
  it("Meldungen: Format und Prüfziffer, Leerzeichen erlaubt", () => {
    expect(ikProblem("10991111")).toMatch(/9 Ziffern/);
    expect(ikProblem("109 911 114")).toBeNull();
    expect(ikProblem("109911115")).toMatch(/Prüfziffer/);
    expect(ikProblem("")).toBeNull();
  });
});

describe("Krankenversichertennummer", () => {
  it("Beispiele aus der Richtlinie § 290 SGB V (A000500015, C000500021)", () => {
    expect(isValidKvnr("A000500015")).toBe(true);
    expect(isValidKvnr("C000500021")).toBe(true);
    expect(kvnrCheckDigit("A00050001")).toBe(5);
    expect(isValidKvnr("A000500016")).toBe(false);
  });
  it("Format: Buchstabe + 9 Ziffern", () => {
    expect(isValidKvnr("1000500015")).toBe(false);
    expect(isValidKvnr("a000500015")).toBe(true);
    expect(isValidKvnr("A00050001")).toBe(false);
  });
});

describe("Arzt- und Betriebsstättennummer", () => {
  it("LANR-Prüfziffer nach ANRV § 4 Abs. 3 (Faktoren 4/9, 10 − Rest)", () => {
    // 1·4 + 2·9 + 3·4 + 4·9 + 5·4 + 6·9 = 144 → Rest 4 → Prüfziffer 6
    expect(lanrCheckDigit("123456")).toBe(6);
    expect(isValidLanr("123456601")).toBe(true);
    expect(isValidLanr("123456701")).toBe(false);
    // Rest 0 → Differenz 10 → Prüfziffer 0
    expect(lanrCheckDigit("000000")).toBe(0);
  });
  it("falsche LANR-Prüfziffer ist nur ein Hinweis, BSNR nur Format", () => {
    expect(lanrProblem("123456701")).toMatch(/bitte mit dem Arztstempel/);
    expect(lanrProblem("12345")).toMatch(/9 Ziffern/);
    expect(bsnrProblem("123456789")).toBeNull();
    expect(bsnrProblem("1234")).toMatch(/9 Ziffern/);
  });
});

describe("Versichertenstatus und LEGS", () => {
  it("erkennt 1/3/5 eindeutig, sonst null", () => {
    expect(parseInsuredStatus("1")).toBe("1");
    expect(parseInsuredStatus("5000000")).toBe("5");
    expect(parseInsuredStatus("3 Familie")).toBe("3");
    expect(parseInsuredStatus("Rentner")).toBe("5");
    expect(parseInsuredStatus("2")).toBeNull();
    expect(parseInsuredStatus("")).toBeNull();
  });
  it("Status für die Positionsnummer aus dem LEGS", () => {
    expect(providerStatusOf("7100501")).toBe("ZL");
    expect(providerStatusOf("7200501")).toBe("ZL");
    expect(providerStatusOf("2700541")).toBe("KH");
    expect(providerStatusOf("2800541")).toBe("KB");
    expect(providerStatusOf(null)).toBe("ZL");
  });
});
