import { describe, expect, it } from "vitest";
import { epcAmount, epcPayload, invoicePaymentQr, isValidBic, isValidIban, normalizeIban } from "./epc-qr";

const IBAN = "DE02120300000000202051";
const org = { name: "Praxis Fußwohl", legalName: "Fußwohl Podologie", accountHolder: "Erika Musterfrau", iban: "DE02 1203 0000 0000 2020 51", bic: "BYLADEM1001" };
const inv = { kind: "invoice", status: "issued", number: "R2026-0042", totalCents: 9500, paidCents: 0 };

describe("IBAN/BIC-Prüfung", () => {
  it("akzeptiert gültige IBANs (auch mit Leerzeichen/Kleinbuchstaben)", () => {
    expect(isValidIban(IBAN)).toBe(true);
    expect(isValidIban("de02 1203 0000 0000 2020 51")).toBe(true);
    expect(isValidIban("AT611904300234573201")).toBe(true);
    expect(normalizeIban("de02 1203-0000")).toBe("DE0212030000");
  });
  it("lehnt falsche Prüfziffer, Länge und Nicht-SEPA-Länder ab", () => {
    expect(isValidIban("DE03120300000000202051")).toBe(false);
    expect(isValidIban("DE0212030000000020205")).toBe(false);
    expect(isValidIban("US02120300000000202051")).toBe(false);
    expect(isValidIban("")).toBe(false);
    expect(isValidIban(null)).toBe(false);
  });
  it("BIC: 8 oder 11 Zeichen", () => {
    expect(isValidBic("BYLADEM1001")).toBe(true);
    expect(isValidBic("COBADEFF")).toBe(true);
    expect(isValidBic("COBADEF")).toBe(false);
  });
});

describe("EPC-Betrag", () => {
  it("formatiert Cent als EUR mit Punkt und zwei Nachkommastellen", () => {
    expect(epcAmount(9500)).toBe("EUR95.00");
    expect(epcAmount(1)).toBe("EUR0.01");
    expect(epcAmount(123456)).toBe("EUR1234.56");
    expect(epcAmount(99_999_999_999)).toBe("EUR999999999.99");
  });
  it("lehnt 0, negative, gebrochene und zu große Beträge ab", () => {
    expect(() => epcAmount(0)).toThrow();
    expect(() => epcAmount(-5)).toThrow();
    expect(() => epcAmount(1.5)).toThrow();
    expect(() => epcAmount(100_000_000_000)).toThrow();
  });
});

describe("EPC-Nutzdaten (GiroCode)", () => {
  it("baut den BCD-Datensatz nach EPC069-12 Version 002", () => {
    const p = epcPayload({ name: "Erika Musterfrau", iban: "de02 1203 0000 0000 2020 51", bic: "byladem1001", amountCents: 9500, remittance: "Rechnung R2026-0042" })!;
    expect(p.split("\n")).toEqual(["BCD", "002", "1", "SCT", "BYLADEM1001", "Erika Musterfrau", IBAN, "EUR95.00", "", "", "Rechnung R2026-0042"]);
  });
  it("BIC ist optional, ungültige BIC wird weggelassen", () => {
    expect(epcPayload({ name: "X", iban: IBAN, amountCents: 100, remittance: "R1" })!.split("\n")[4]).toBe("");
    expect(epcPayload({ name: "X", iban: IBAN, bic: "DE-123", amountCents: 100, remittance: "R1" })!.split("\n")[4]).toBe("");
  });
  it("kürzt Name (70) und Verwendungszweck (140), entfernt Zeilenumbrüche", () => {
    const p = epcPayload({ name: `A\nB ${"x".repeat(100)}`, iban: IBAN, amountCents: 100, remittance: "y".repeat(200) })!.split("\n");
    expect(p).toHaveLength(11);
    expect(p[5].startsWith("A B ")).toBe(true);
    expect(p[5]).toHaveLength(70);
    expect(p[10]).toHaveLength(140);
  });
  it("null bei ungültiger IBAN, fehlendem Namen oder Betrag 0", () => {
    expect(epcPayload({ name: "X", iban: "DE03120300000000202051", amountCents: 100, remittance: "" })).toBeNull();
    expect(epcPayload({ name: " ", iban: IBAN, amountCents: 100, remittance: "" })).toBeNull();
    expect(epcPayload({ name: "X", iban: IBAN, amountCents: 0, remittance: "" })).toBeNull();
  });
});

describe("GiroCode auf der Rechnung", () => {
  it("offene Rechnung: offener Betrag, Kontoinhaber, Rechnungsnummer als Verwendungszweck", () => {
    const p = invoicePaymentQr({ ...inv, status: "partially_paid", paidCents: 2000 }, org)!.split("\n");
    expect(p[5]).toBe("Erika Musterfrau");
    expect(p[7]).toBe("EUR75.00");
    expect(p[10]).toBe("Rechnung R2026-0042");
  });
  it("Empfänger fällt auf rechtlichen Namen bzw. Praxisnamen zurück", () => {
    expect(invoicePaymentQr(inv, { ...org, accountHolder: null })!.split("\n")[5]).toBe("Fußwohl Podologie");
    expect(invoicePaymentQr(inv, { ...org, accountHolder: "", legalName: null })!.split("\n")[5]).toBe("Praxis Fußwohl");
  });
  it("kein GiroCode bei Quittung (bar bezahlt), Anzahlung, Storno, bezahlt, Entwurf, ohne offenen Betrag oder IBAN", () => {
    expect(invoicePaymentQr({ ...inv, kind: "receipt", status: "paid", paidCents: 9500 }, org)).toBeNull();
    expect(invoicePaymentQr({ ...inv, kind: "receipt" }, org)).toBeNull();
    expect(invoicePaymentQr({ ...inv, kind: "deposit" }, org)).toBeNull();
    expect(invoicePaymentQr({ ...inv, kind: "credit_note", totalCents: -9500 }, org)).toBeNull();
    expect(invoicePaymentQr({ ...inv, status: "paid", paidCents: 9500 }, org)).toBeNull();
    expect(invoicePaymentQr({ ...inv, status: "draft" }, org)).toBeNull();
    expect(invoicePaymentQr({ ...inv, status: "cancelled" }, org)).toBeNull();
    expect(invoicePaymentQr({ ...inv, paidCents: 9600 }, org)).toBeNull();
    expect(invoicePaymentQr(inv, { ...org, iban: null })).toBeNull();
    expect(invoicePaymentQr(inv, { ...org, iban: "DE00 0000" })).toBeNull();
  });
  it("Sammelrechnung und Ausfallhonorar erhalten einen GiroCode", () => {
    expect(invoicePaymentQr({ ...inv, kind: "collective" }, org)).not.toBeNull();
    expect(invoicePaymentQr({ ...inv, kind: "no_show_fee" }, org)).not.toBeNull();
  });
});
