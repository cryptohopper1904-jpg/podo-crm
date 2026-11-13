import { describe, expect, it } from "vitest";
import { dateDe, money } from "./format";
import { dueImmediately, dueLabel, invoiceHeading, paymentNoteLines } from "./invoice-view";

const inv = { kind: "invoice", status: "issued", number: "R2026-0042", issuedAt: "2026-11-13", dueAt: "2026-11-27", totalCents: 9500, paidCents: 0, paymentLinkUrl: null };
const fmt = { dateDe, money };
const iban = { iban: "DE02120300000000202051" };

describe("Überschrift mit Leistungsdatum", () => {
  it("Rechnung: Behandlungstag aus dem Termin; ohne Bezug kein behauptetes Datum, sondern Vorbehaltshinweis; mehrere Tage als Zeitraum", () => {
    expect(invoiceHeading(inv, ["2026-11-09"], dateDe).heading).toBe("Rechnung zur Behandlung am 09.11.2026");
    expect(invoiceHeading(inv, [], dateDe)).toEqual({ heading: "Rechnung", serviceDateNote: expect.stringMatching(/Leistungsdatum entspricht dem Rechnungsdatum/) });
    expect(invoiceHeading(inv, ["2026-11-10", "2026-11-03"], dateDe).heading).toBe("Rechnung zur Behandlung im Zeitraum vom 03.11.2026 bis 10.11.2026");
  });
  it("andere Belegarten", () => {
    expect(invoiceHeading({ ...inv, kind: "receipt" }, ["2026-11-09"], dateDe).heading).toBe("Quittung zur Behandlung am 09.11.2026");
    expect(invoiceHeading({ ...inv, kind: "credit_note" }, [], dateDe, "R2026-0040").heading).toBe("Stornorechnung zur Rechnung R2026-0040");
    expect(invoiceHeading({ ...inv, kind: "collective" }, ["2026-11-09"], dateDe)).toEqual({ heading: "Sammelrechnung zur Behandlung am 09.11.2026", serviceDateNote: null });
    expect(invoiceHeading({ ...inv, kind: "receipt" }, [], dateDe).heading).toBe("Quittung");
    expect(invoiceHeading({ ...inv, kind: "collective" }, [], dateDe)).toEqual({ heading: "Sammelrechnung", serviceDateNote: expect.stringMatching(/Leistungsdatum/) });
    expect(invoiceHeading({ ...inv, kind: "deposit" }, [], dateDe).heading).toBe("Quittung über eine Anzahlung");
  });
});

describe("Zahlungshinweis nach Zahlart und Stand", () => {
  it("offen per Überweisung (mit GiroCode-Tipp und Zahlungslink)", () => {
    const l = paymentNoteLines({ ...inv, paymentLinkUrl: "https://pay.example/x" }, [], iban, fmt, { giroCode: true });
    expect(l[0]).toMatch(/^Zahlung per Überweisung: .* bis zum 27\.11\.2026 .* R2026-0042/);
    expect(l[1]).toMatch(/GiroCode/);
    expect(l[2]).toBe("Oder bequem online bezahlen: https://pay.example/x");
  });
  it("ohne IBAN nur Zahlungsziel", () => {
    expect(paymentNoteLines(inv, [], { iban: null }, fmt)).toEqual(["Zahlbar bis zum 27.11.2026 ohne Abzug."]);
  });
  it("bar bezahlte Quittung bzw. bezahlte Rechnung", () => {
    expect(paymentNoteLines({ ...inv, kind: "receipt", status: "paid", paidCents: 9500 }, [{ method: "cash", amountCents: 9500 }], iban, fmt)).toEqual(["Zahlung in bar – Betrag dankend erhalten."]);
    expect(paymentNoteLines({ ...inv, status: "paid", paidCents: 9500 }, [{ method: "transfer", amountCents: 9500 }], iban, fmt)).toEqual(["Der Rechnungsbetrag wurde per Überweisung bezahlt – vielen Dank."]);
  });
  it("teilbezahlt, Storno, Erstattung", () => {
    const l = paymentNoteLines({ ...inv, status: "partially_paid", paidCents: 2000 }, [{ method: "card", amountCents: 2000 }], iban, fmt);
    expect(l[0].replace(/\s/g, " ")).toBe("Bereits bezahlt per Karte: 20,00 €. Offen: 75,00 €.");
    expect(paymentNoteLines({ ...inv, status: "cancelled" }, [], iban, fmt)).toEqual([]);
    expect(paymentNoteLines({ ...inv, kind: "credit_note", totalCents: -9500, paidCents: 0, status: "issued" }, [], iban, fmt)[0]).toMatch(/erstattet/);
  });
});

describe("Zahlungsziel sofort (0 Tage)", () => {
  const now = { ...inv, issuedAt: "2026-11-13", dueAt: "2026-11-13" };
  it("Fälligkeit am Rechnungstag heißt „sofort“", () => {
    expect(dueImmediately(now)).toBe(true);
    expect(dueLabel(now, dateDe)).toBe("sofort");
    expect(dueImmediately(inv)).toBe(false);
    expect(dueLabel({ ...inv, issuedAt: "2026-11-13" }, dateDe)).toBe("27.11.2026");
  });
  it("Zahlungshinweis nennt „sofort“ statt Datum", () => {
    expect(paymentNoteLines(now, [], iban, fmt).join(" ")).toMatch(/überweisen Sie den Betrag sofort unter Angabe/);
    expect(paymentNoteLines(now, [], { iban: null }, fmt)).toContain("Zahlbar sofort ohne Abzug.");
  });
});
