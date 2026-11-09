import { describe, expect, it } from "vitest";
import { chainHash } from "@/lib/records";
import { buildBons, closingHashContent, computeClosing, countedTotal, itemsDigest, normalizeDenominations, parseTseRef, reviveBons, serializeBons, verifyClosingRows, type KassePayment } from "./model";

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

  it("Kette: Snapshot der Bons geht in den Hash ein (Altbestand ohne Snapshot unverändert), Lücken werden erkannt", () => {
    const legacy = chainHash(null, closingHashContent(base));
    expect(chainHash(null, closingHashContent({ ...base, bons: undefined }))).toBe(legacy);
    const bons = buildBons({ zNumber: 1, firstBonNr: 1, closedAt: base.closedAt, openingCents: 0, openingIsNew: true, differenceCents: 0, payments: [{ ...p("a", "cash", 100, 1), tse: { serial: "S", number: 1, signatureCounter: 2, isTest: false, signature: "sig", startedAt: new Date(0), finishedAt: new Date(1000) } }], movements: [] });
    const snap = serializeBons(bons);
    expect(reviveBons(snap)).toEqual(bons);
    const withSnap = { ...base, bons: snap };
    const h = chainHash(null, closingHashContent(withSnap));
    expect(h).not.toBe(legacy);
    const row1 = { ...withSnap, prevHash: null, hash: h };
    expect(verifyClosingRows([row1])).toBe(-1);
    // geänderter Snapshot (z. B. Gutscheincode/USt) bricht die Kette
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered[0].lines[0].text = "anders";
    expect(verifyClosingRows([{ ...row1, bons: tampered }])).toBe(0);
    // Z-Nummer mit Lücke bzw. Belegnummern nicht fortlaufend
    const z3 = { ...base, id: "c3", number: 3, firstBonNr: 2, lastBonNr: 2 };
    expect(verifyClosingRows([row1, { ...z3, prevHash: h, hash: chainHash(h, closingHashContent(z3)) }])).toBe(1);
    const z2 = { ...base, id: "c2", number: 2, firstBonNr: 5, lastBonNr: 5 };
    expect(verifyClosingRows([row1, { ...z2, prevHash: h, hash: chainHash(h, closingHashContent(z2)) }])).toBe(1);
  });
});

describe("Kasse: Anzahlung (Quittung für die Sammelrechnung)", () => {
  it("bucht die Zahlung als AnzahlungEinstellung (nicht als Umsatz), zählt sie aber bei Bar und USt-Summe", () => {
    const dep: KassePayment = { ...p("d", "cash", 6500, 5), invoiceNumber: "AZ2026-0001", vatGroups: [{ rate: 0, grossCents: 6500 }], deposit: true };
    const c = computeClosing({
      zNumber: 1,
      firstBonNr: 1,
      closedAt: new Date(Date.UTC(2026, 10, 6, 17)),
      openingCents: 0,
      openingIsNew: false,
      denominations: { "5000": 1, "1000": 1, "500": 1 },
      payments: [dep],
      movements: [],
    });
    expect(c.bons).toHaveLength(1);
    expect(c.bons[0].lines).toEqual([expect.objectContaining({ gvTyp: "AnzahlungEinstellung", ustKey: 6, grossCents: 6500, text: "Anzahlung AZ2026-0001 (0 % USt)" })]);
    expect(c.bons[0].payments).toEqual([{ typ: "Bar", name: "Bar", amountCents: 6500 }]);
    expect(c.cashPaymentsCents).toBe(6500);
    expect(c.differenceCents).toBe(0);
    expect(c.totals.businessCases).toEqual([expect.objectContaining({ gvTyp: "AnzahlungEinstellung", ustKey: 6, grossCents: 6500 })]);
    expect(c.totals.byVat).toEqual([expect.objectContaining({ rate: 0, grossCents: 6500 })]);
  });

  it("Erstattung einer stornierten Anzahlung bleibt eine (negative) Anzahlungsbuchung", () => {
    const refund: KassePayment = { ...p("r", "cash", -6500, 6), invoiceNumber: "GS2026-0001", vatGroups: [{ rate: 0, grossCents: -6500 }], deposit: true };
    const [bon] = buildBons({ zNumber: 1, firstBonNr: 1, closedAt: new Date(), openingCents: 0, openingIsNew: false, differenceCents: 0, payments: [refund], movements: [] });
    expect(bon.lines).toEqual([expect.objectContaining({ gvTyp: "AnzahlungEinstellung", grossCents: -6500 })]);
  });
});
