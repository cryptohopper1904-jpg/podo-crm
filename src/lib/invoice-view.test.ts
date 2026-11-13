import { describe, expect, it } from "vitest";
import { dateDe, money } from "./format";
import { dueImmediately, dueLabel, invoiceHeading, paymentNoteLines } from "./invoice-view";

const inv = { kind: "invoice", status: "issued", number: "R2026-0042", issuedAt: "2026-11-13", dueAt: "2026-11-27", totalCents: 9500, paidCents: 0, paymentLinkUrl: null };
const fmt = { dateDe, money };
const iban = { iban: "DE02120300000000202051" };

describe("Überschrift mit Leistungsdatum (§ 14 Abs. 4 Nr. 6 UStG)", () => {
  const h = (patch: Partial<typeof inv> & { serviceDate?: string | null }, dates: string[] = [], cancels?: string) => invoiceHeading({ ...inv, ...patch }, dates, dateDe, cancels);

  it("Rechnung mit verknüpftem Termin: Behandlungstag in der Überschrift, kein Zusatzhinweis – auch wenn Rechnungsdatum abweicht", () => {
    expect(h({}, ["2026-11-09"])).toEqual({ heading: "Rechnung zur Behandlung am 09.11.2026", serviceDateNote: null });
    expect(h({}, ["2026-11-10", "2026-11-03", "2026-11-10"]).heading).toBe("Rechnung zur Behandlung im Zeitraum vom 03.11.2026 bis 10.11.2026");
  });
  it("verknüpfte Termine haben Vorrang vor einem gespeicherten Leistungsdatum", () => {
    expect(h({ serviceDate: "2026-11-13" }, ["2026-11-09"])).toEqual({ heading: "Rechnung zur Behandlung am 09.11.2026", serviceDateNote: null });
  });
  it("Rechnung ohne Bezug mit Leistungsdatum aus dem Formular: neutrale Überschrift + ausdrückliches Datum, kein Vorbehalt", () => {
    expect(h({ serviceDate: "2026-11-12" })).toEqual({ heading: "Rechnung", serviceDateNote: "Leistungsdatum: 12.11.2026" });
    // gleicher Tag wie das Rechnungsdatum: trotzdem ausdrücklich
    expect(h({ serviceDate: "2026-11-13" }).serviceDateNote).toBe("Leistungsdatum: 13.11.2026");
  });
  it("Altbestand ohne Bezug und ohne gespeichertes Leistungsdatum: unveränderter Hinweis wie beim Ausstellen gedruckt", () => {
    expect(h({})).toEqual({ heading: "Rechnung", serviceDateNote: "Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben." });
    expect(h({ kind: "receipt" }).serviceDateNote).toMatch(/Leistungsdatum entspricht dem Rechnungsdatum/);
  });
  it("Quittung aus einem Termin an einem anderen Tag: Termin-Datum, nicht das Quittungsdatum", () => {
    expect(h({ kind: "receipt", issuedAt: "2026-11-13" }, ["2026-03-12"])).toEqual({ heading: "Quittung zur Behandlung am 12.03.2026", serviceDateNote: null });
  });
  it("Quittung am selben Tag (Termin heute bzw. ohne Termin mit Standard-Leistungsdatum)", () => {
    expect(h({ kind: "receipt" }, ["2026-11-13"]).heading).toBe("Quittung zur Behandlung am 13.11.2026");
    expect(h({ kind: "receipt", serviceDate: "2026-11-13" })).toEqual({ heading: "Quittung", serviceDateNote: "Leistungsdatum: 13.11.2026" });
  });
  it("Sammelrechnung: Zeitraum aus den Terminen, ein Tag, ohne Bezug mit Leistungsdatum", () => {
    expect(h({ kind: "collective" }, ["2026-01-15", "2026-12-02", "2026-06-30"])).toEqual({ heading: "Sammelrechnung für den Zeitraum vom 15.01.2026 bis 02.12.2026", serviceDateNote: null });
    expect(h({ kind: "collective" }, ["2026-11-09"])).toEqual({ heading: "Sammelrechnung zur Behandlung am 09.11.2026", serviceDateNote: null });
    expect(h({ kind: "collective", serviceDate: "2026-10-31" })).toEqual({ heading: "Sammelrechnung", serviceDateNote: "Leistungsdatum: 31.10.2026" });
  });
  it("Ausfallhonorar: Datum des versäumten Termins (verknüpft oder eingetragen), kein Leistungsdatum", () => {
    expect(h({ kind: "no_show_fee" }, ["2026-11-09"])).toEqual({ heading: "Ausfallhonorar für den Termin am 09.11.2026", serviceDateNote: null });
    expect(h({ kind: "no_show_fee", serviceDate: "2026-11-10" })).toEqual({ heading: "Ausfallhonorar für den Termin am 10.11.2026", serviceDateNote: null });
    expect(h({ kind: "no_show_fee" })).toEqual({ heading: "Ausfallhonorar", serviceDateNote: null });
  });
  it("Anzahlung: Tag der Zahlung statt Leistungsdatum; künftige Behandlung = Leistung noch nicht erbracht", () => {
    expect(h({ kind: "deposit", issuedAt: "2026-11-13" }, ["2026-11-20"])).toEqual({
      heading: "Quittung über eine Anzahlung",
      serviceDateNote: "Anzahlung erhalten am 13.11.2026 für die Behandlung am 20.11.2026 – Leistung noch nicht erbracht.",
    });
    expect(h({ kind: "deposit", issuedAt: "2026-11-13" }, ["2026-11-13"]).serviceDateNote).toBe("Anzahlung erhalten am 13.11.2026 für die Behandlung am 13.11.2026.");
    expect(h({ kind: "deposit", issuedAt: "2026-11-13" }, ["2026-11-02"]).serviceDateNote).toBe("Anzahlung erhalten am 13.11.2026 für die Behandlung am 02.11.2026.");
    const none = h({ kind: "deposit", issuedAt: "2026-11-13" });
    expect(none.serviceDateNote).toMatch(/^Anzahlung erhalten am 13\.11\.2026\. .*Leistungsdatum steht dort/);
    expect(none.serviceDateNote).not.toMatch(/entspricht dem Rechnungsdatum/);
  });
  it("Stornorechnung: Bezug zur Rechnung, Leistungsdatum der stornierten Rechnung (sofern bekannt)", () => {
    expect(h({ kind: "credit_note" }, [], "R2026-0040")).toEqual({ heading: "Stornorechnung zur Rechnung R2026-0040", serviceDateNote: null });
    expect(h({ kind: "credit_note" }, ["2026-11-09"], "R2026-0040").serviceDateNote).toBe("Leistungsdatum der stornierten Rechnung: 09.11.2026");
    expect(h({ kind: "credit_note" }, ["2026-11-03", "2026-11-09"], "R2026-0040").serviceDateNote).toBe("Leistungsdatum der stornierten Rechnung: 03.11.2026 bis 09.11.2026");
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
