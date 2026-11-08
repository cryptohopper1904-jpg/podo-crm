import { describe, expect, it } from "vitest";
import { chainHash } from "@/lib/records";
import { buildBons, closingHashContent, computeClosing, countedTotal, itemsDigest, normalizeDenominations, parseTseRef, type KassePayment } from "./model";

const p = (id: string, method: KassePayment["method"], amountCents: number, minute: number): KassePayment => ({
  id,
  method,
  amountCents,
  paidAt: new Date(Date.UTC(2026, 10, 6, 9, minute)),
  invoiceNumber: "R1",
  vatGroups: [{ rate: 19, grossCents: 11900 }],
  voucher: null,
  soldVoucher: null,
  externalRef: null,
  tse: null,
  createdBy: null,
});

describe("Kasse: Zählprotokoll", () => {
  it("summiert Stückelungen und weist Unsinn ab", () => {
    expect(countedTotal(normalizeDenominations({ "5000": "2", "200": 3, "1": "" }))).toBe(10600);
    expect(() => normalizeDenominations({ "300": 1 })).toThrow();
    expect(() => normalizeDenominations({ "100": -1 })).toThrow();
    expect(() => normalizeDenominations({ "100": 1.5 })).toThrow();
  });
});

describe("Kasse: Abschluss-Berechnung", () => {
  it("Soll = Anfang + Bar + Bewegungen; Differenz = Ist − Soll; Belegnummern fortlaufend ab firstBonNr", () => {
    const c = computeClosing({
      zNumber: 3,
      firstBonNr: 11,
      closedAt: new Date(Date.UTC(2026, 10, 6, 17)),
      openingCents: 5000,
      openingIsNew: false,
      denominations: { "5000": 3 },
      payments: [p("b", "cash", 11900, 2), p("a", "card", 2000, 1), p("c", "transfer", 3000, 3)],
      movements: [{ id: "m", kind: "transit_out", amountCents: -2000, reason: "Bank", occurredAt: new Date(Date.UTC(2026, 10, 6, 12)), createdBy: null }],
    });
    expect(c.cashPaymentsCents).toBe(11900);
    expect(c.expectedCashCents).toBe(5000 + 11900 - 2000);
    expect(c.differenceCents).toBe(15000 - 14900);
    // a (Karte), b (Bar), m, Differenz – Überweisung c ist kein Kassenvorgang
    expect(c.bons.map((b) => [b.bonNr, b.bonId])).toEqual([
      [11, "a"],
      [12, "b"],
      [13, "m"],
      [14, "Z3-DIFF"],
    ]);
    expect(c.lastBonNr).toBe(14);
    expect(c.totals.byMethod).toEqual({ cash: 11900, card: 2000, transfer: 3000 });
    const v19 = c.totals.byVat.find((v) => v.rate === 19)!;
    expect(v19.grossCents).toBe(13900);
    expect(v19.netCents + v19.vatCents).toBe(13900);
    expect(v19.vatCents).toBe(1900 + 319);
  });

  it("Reihenfolge der Eingabe ändert weder Belege noch Prüfsumme", () => {
    const a = [p("x", "cash", 100, 1), p("y", "cash", 200, 2)];
    const args = { zNumber: 1, firstBonNr: 1, closedAt: new Date(), openingCents: 0, openingIsNew: true, differenceCents: 0, movements: [] };
    expect(buildBons({ ...args, payments: a }).map((b) => b.bonId)).toEqual(buildBons({ ...args, payments: [...a].reverse() }).map((b) => b.bonId));
    expect(itemsDigest(a, [])).toBe(itemsDigest([...a].reverse(), []));
    expect(itemsDigest(a, [])).not.toBe(itemsDigest([{ ...a[0], amountCents: 101 }, a[1]], []));
  });

  it("TSE-Referenz wird gelesen (echt/Test)", () => {
    expect(parseTseRef("tse:test:MOCK-TSE:5:9")).toEqual({ serial: "MOCK-TSE", number: 5, signatureCounter: 9, isTest: true });
    expect(parseTseRef("tse:ABC:DEF:12:13")).toEqual({ serial: "ABC:DEF", number: 12, signatureCounter: 13, isTest: false });
    expect(parseTseRef("sumup:123")).toBeNull();
  });
});

describe("Kasse: Hash-Kette", () => {
  const base = {
    id: "00000000-0000-0000-0000-000000000001",
    organizationId: "o",
    number: 1,
    businessDate: "2026-11-06",
    closedAt: new Date("2026-11-06T17:00:00.000Z"),
    createdAt: new Date("2026-11-06T17:00:01.000Z"),
    openingCents: 0,
    cashPaymentsCents: 100,
    movementsCents: 0,
    expectedCashCents: 100,
    countedCashCents: 100,
    differenceCents: 0,
    denominations: { "100": 1 },
    totals: { byMethod: { cash: 100 }, byVat: [], movements: {}, businessCases: [] },
    paymentCount: 1,
    movementCount: 0,
    firstBonNr: 1,
    lastBonNr: 1,
    itemsDigest: "d",
    tse: { mode: "none", testSignatures: undefined, note: "x" },
    differenceReason: null,
    note: null,
    createdBy: null,
  };
  it("ist stabil gegenüber JSON-Rundreise (jsonb) und erkennt Änderungen", () => {
    const h1 = chainHash(null, closingHashContent(base));
    const roundTrip = { ...base, tse: JSON.parse(JSON.stringify(base.tse)), totals: JSON.parse(JSON.stringify(base.totals)) };
    expect(chainHash(null, closingHashContent(roundTrip))).toBe(h1);
    expect(chainHash(null, closingHashContent({ ...base, countedCashCents: 101 }))).not.toBe(h1);
    expect(chainHash(h1, closingHashContent({ ...base, number: 2 }))).not.toBe(chainHash(null, closingHashContent({ ...base, number: 2 })));
  });
});
