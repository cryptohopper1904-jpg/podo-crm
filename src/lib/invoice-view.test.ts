import { describe, expect, it } from "vitest";
import { dateDe, money } from "./format";
import { dueImmediately, dueLabel, invoiceHeading, legacyHeading, paymentNoteLines, serviceDays, serviceRange, type InvoiceService } from "./invoice-view";

const inv = { kind: "invoice", status: "issued", number: "R2026-0042", issuedAt: "2026-11-13", dueAt: "2026-11-27", totalCents: 9500, paidCents: 0, paymentLinkUrl: null };
const fmt = { dateDe, money };
const iban = { iban: "DE02120300000000202051" };

describe("Überschrift mit Leistungsdatum (§ 14 Abs. 4 Nr. 6 UStG) – festgeschriebene Belege", () => {
  const h = (patch: Partial<typeof inv>, dates: string[] = [], linked = false, cancels: InvoiceService["cancels"] = null) =>
    invoiceHeading({ ...inv, ...patch }, { dates, linked, fixed: true, cancels }, dateDe);

  it("mit Termin: Behandlungstag in der Überschrift – auch wenn das Rechnungsdatum abweicht; Zeitraum bei mehreren Tagen", () => {
    expect(h({}, ["2026-11-09"], true)).toEqual({ heading: "Rechnung zur Behandlung am 09.11.2026", serviceDateNote: null });
    expect(h({}, ["2026-11-03", "2026-11-10"], true).heading).toBe("Rechnung zur Behandlung im Zeitraum vom 03.11.2026 bis 10.11.2026");
    expect(h({ kind: "receipt", issuedAt: "2026-11-13" }, ["2026-03-12"], true)).toEqual({ heading: "Quittung zur Behandlung am 12.03.2026", serviceDateNote: null });
  });
  it("ohne Termin: neutrale Überschrift + ausdrückliches Datum bzw. Zeitraum, kein Vorbehalt", () => {
    expect(h({}, ["2026-11-12"])).toEqual({ heading: "Rechnung", serviceDateNote: "Leistungsdatum: 12.11.2026" });
    expect(h({ kind: "receipt" }, ["2026-11-13"])).toEqual({ heading: "Quittung", serviceDateNote: "Leistungsdatum: 13.11.2026" });
    expect(h({ kind: "collective" }, ["2026-10-01", "2026-10-31"])).toEqual({ heading: "Sammelrechnung", serviceDateNote: "Leistungszeitraum: 01.10.2026 bis 31.10.2026" });
  });
  it("Sammelrechnung mit Terminen: Zeitraum bzw. ein Tag", () => {
    expect(h({ kind: "collective" }, ["2026-01-15", "2026-12-02"], true).heading).toBe("Sammelrechnung für den Zeitraum vom 15.01.2026 bis 02.12.2026");
    expect(h({ kind: "collective" }, ["2026-11-09"], true).heading).toBe("Sammelrechnung zur Behandlung am 09.11.2026");
  });
  it("Ausfallhonorar: Datum des versäumten Termins, kein Leistungsdatum", () => {
    expect(h({ kind: "no_show_fee" }, ["2026-11-10"])).toEqual({ heading: "Ausfallhonorar für den Termin am 10.11.2026", serviceDateNote: null });
  });
  it("Anzahlung: Tag der Zahlung; künftige Behandlung = Leistung noch nicht erbracht; ohne Bezug Verweis auf die Rechnung", () => {
    expect(h({ kind: "deposit", issuedAt: "2026-11-13" }, ["2026-11-20"], true).serviceDateNote).toBe("Anzahlung erhalten am 13.11.2026 für die Behandlung am 20.11.2026 – Leistung noch nicht erbracht.");
    expect(h({ kind: "deposit", issuedAt: "2026-11-13" }, ["2026-11-02"], true).serviceDateNote).toBe("Anzahlung erhalten am 13.11.2026 für die Behandlung am 02.11.2026.");
    expect(h({ kind: "deposit", issuedAt: "2026-11-13" }).serviceDateNote).toMatch(/^Anzahlung erhalten am 13\.11\.2026\. .*Leistungsdatum steht dort/);
  });
  it("Storno: Leistungsdatum der Rechnung, „Anzahlung vom …“ bzw. „Termin am …“", () => {
    const r = { number: "R2026-0040", kind: "invoice", issuedAt: "2026-11-10" };
    expect(h({ kind: "credit_note" }, ["2026-11-09"], false, r)).toEqual({ heading: "Stornorechnung zur Rechnung R2026-0040", serviceDateNote: "Leistungsdatum der stornierten Rechnung: 09.11.2026" });
    expect(h({ kind: "credit_note" }, ["2026-11-03", "2026-11-09"], false, r).serviceDateNote).toBe("Leistungszeitraum der stornierten Rechnung: 03.11.2026 bis 09.11.2026");
    expect(h({ kind: "credit_note" }, [], false, r).serviceDateNote).toBeNull();
    const az = { number: "AZ2026-0003", kind: "deposit", issuedAt: "2026-11-05" };
    expect(h({ kind: "credit_note" }, ["2026-11-20"], false, az)).toEqual({ heading: "Stornorechnung zur Anzahlung AZ2026-0003", serviceDateNote: "Storno der Anzahlung vom 05.11.2026." });
    const af = { number: "A2026-0001", kind: "no_show_fee", issuedAt: "2026-11-12" };
    expect(h({ kind: "credit_note" }, ["2026-11-10"], false, af).serviceDateNote).toBe("Ausfallhonorar für den Termin am 10.11.2026.");
  });
});

describe("Altbelege (vor dem festgeschriebenen Leistungsdatum) sehen beim Neudruck genau wie früher aus", () => {
  const old = (patch: Partial<typeof inv>, dates: string[] = [], cancels: InvoiceService["cancels"] = null) =>
    invoiceHeading({ ...inv, ...patch }, { dates, linked: dates.length > 0, fixed: false, cancels }, dateDe);
  it("frühere Texte unverändert", () => {
    expect(old({}, ["2026-11-09"])).toEqual({ heading: "Rechnung zur Behandlung am 09.11.2026", serviceDateNote: null });
    expect(old({})).toEqual({ heading: "Rechnung", serviceDateNote: "Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben." });
    expect(old({ kind: "receipt" })).toEqual({ heading: "Quittung", serviceDateNote: "Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben." });
    expect(old({ kind: "collective" }, ["2026-11-03", "2026-11-10"]).heading).toBe("Sammelrechnung für den Zeitraum vom 03.11.2026 bis 10.11.2026");
    // Anzahlung und Storno: früher ohne Zusatzzeile, Storno immer „zur Rechnung“
    expect(old({ kind: "deposit" }, ["2026-11-20"])).toEqual({ heading: "Quittung über eine Anzahlung", serviceDateNote: null });
    expect(old({ kind: "credit_note" }, [], { number: "AZ2026-0003", kind: "deposit", issuedAt: "2026-11-05" })).toEqual({ heading: "Stornorechnung zur Rechnung AZ2026-0003", serviceDateNote: null });
    expect(old({ kind: "no_show_fee" }, ["2026-11-09"]).heading).toBe("Ausfallhonorar für den Termin am 09.11.2026");
  });
  it("legacyHeading entspricht der früheren invoiceHeading", () => {
    expect(legacyHeading(inv, ["2026-11-10", "2026-11-03"], dateDe).heading).toBe("Rechnung zur Behandlung im Zeitraum vom 03.11.2026 bis 10.11.2026");
  });
});

describe("Leistungszeitraum beim Ausstellen", () => {
  it("verknüpfte Tage und Formular-Datum gemeinsam (erster/letzter Tag); ein Tag → ohne bis", () => {
    expect(serviceRange(["2026-03-12"], null)).toEqual({ from: "2026-03-12", to: null });
    expect(serviceRange(["2026-03-12", "2026-03-05"], { from: "2026-03-20" })).toEqual({ from: "2026-03-05", to: "2026-03-20" });
    expect(serviceRange([], { from: "2026-10-01", to: "2026-10-31" })).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(serviceRange([], null)).toBeNull();
    expect(serviceDays({ serviceDate: "2026-10-01", serviceDateTo: "2026-10-31" })).toEqual(["2026-10-01", "2026-10-31"]);
    expect(serviceDays({ serviceDate: null }, ["2026-11-09", "2026-11-01", "2026-11-05"])).toEqual(["2026-11-01", "2026-11-09"]);
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
