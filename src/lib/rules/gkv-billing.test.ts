import { describe, expect, it } from "vitest";
import {
  APPROVAL_REF_PATTERN,
  PRESCRIPTION_KIND_CODES,
  PRESCRIPTION_SPECIAL_CODES,
  canChangeDeductionStatus,
  cleanText,
  deductionPending,
  deductionTotals,
  isPrescriptionKind,
  suggestPrescriptionKind,
} from "./gkv-billing";
import { VERORDNUNGSART, VERORDNUNGSBESONDERHEIT } from "@/lib/gkv302/schluessel";
import { canTransition, evaluatePrescription, STATUS_LABEL } from "./prescription";

describe("GKV Paket C – Kennzeichen Verordnungsart", () => {
  it("nur 03 und 04 wählbar (05 Blankoverordnung nicht für Podologie); Teilmenge der § 302-Schlüssel", () => {
    expect(PRESCRIPTION_KIND_CODES).toEqual(["03", "04"]);
    for (const k of PRESCRIPTION_KIND_CODES) expect(VERORDNUNGSART).toContain(k);
    expect(isPrescriptionKind("05")).toBe(false);
    expect(isPrescriptionKind("03")).toBe(true);
  });

  it("Verordnungsbesonderheiten = Schlüssel der § 302-Bibliothek (8.1.11)", () => {
    expect([...PRESCRIPTION_SPECIAL_CODES].sort()).toEqual([...VERORDNUNGSBESONDERHEIT].sort());
  });

  it("Vorschlag nur aus belegten Daten: Genehmigung B2 → 04; sonst kein Vorschlag (nie raten)", () => {
    expect(suggestPrescriptionKind({ approvalRef: "G-17" })).toEqual({ kind: "04", reason: expect.stringContaining("§ 7 Abs. 6") });
    expect(suggestPrescriptionKind({ approvalRef: "  " })).toBeNull();
    expect(suggestPrescriptionKind({})).toBeNull();
  });

  it("Genehmigungskennzeichen: höchstens 20 Zeichen, keine Steuer-/Sonderzeichen", () => {
    expect(APPROVAL_REF_PATTERN.test("G-2026/17")).toBe(true);
    expect(APPROVAL_REF_PATTERN.test("A")).toBe(true);
    expect(APPROVAL_REF_PATTERN.test("x".repeat(21))).toBe(false);
    expect(APPROVAL_REF_PATTERN.test("A'B")).toBe(false);
    expect(APPROVAL_REF_PATTERN.test("A+B")).toBe(false);
    expect(APPROVAL_REF_PATTERN.test(" A")).toBe(false);
  });
});

describe("GKV Paket C – Absetzungen", () => {
  it("Statuswechsel: erledigt ist abschließend; Widerspruch kann wieder offen werden", () => {
    expect(canChangeDeductionStatus("open", "objected")).toBe(true);
    expect(canChangeDeductionStatus("objected", "open")).toBe(true);
    expect(canChangeDeductionStatus("accepted", "done")).toBe(true);
    expect(canChangeDeductionStatus("done", "open")).toBe(false);
    expect(canChangeDeductionStatus("accepted", "open")).toBe(false);
  });

  it("Summen je Status; offen = offen + Widerspruch", () => {
    const t = deductionTotals([
      { status: "open", amountCents: 1000 },
      { status: "objected", amountCents: 250 },
      { status: "done", amountCents: 99 },
      { status: "kaputt", amountCents: 5 },
    ]);
    expect(t.open).toEqual({ count: 1, cents: 1000 });
    expect(t.objected).toEqual({ count: 1, cents: 250 });
    expect(t.done.cents).toBe(99);
    expect(t.pendingCents).toBe(1250);
    expect(deductionPending("objected")).toBe(true);
    expect(deductionPending("accepted")).toBe(false);
  });

  it("Freitext ohne Steuerzeichen, gekürzt", () => {
    expect(cleanText("a\nb\u0007c  d", 100)).toBe("a b c d");
    expect(cleanText("x".repeat(20), 5)).toBe("xxxxx");
    expect(cleanText(null, 5)).toBe("");
  });
});

describe("GKV Paket C – Status „Korrektur nötig“", () => {
  it("aus „abgerechnet“ kein normaler Statuswechsel; aus „Korrektur nötig“ nur erneut abrechnungsreif", () => {
    expect(STATUS_LABEL.correction_needed).toBe("Korrektur nötig");
    expect(canTransition("billed", "correction_needed")).toMatchObject({ ok: false });
    expect(canTransition("correction_needed", "billing_ready", { unitsUsed: 2, units: 2 })).toEqual({ ok: true });
    expect(canTransition("correction_needed", "billing_ready", { unitsUsed: 0, units: 2 })).toMatchObject({ ok: false });
    expect(canTransition("correction_needed", "billed")).toMatchObject({ ok: false });
    expect(canTransition("correction_needed", "open")).toMatchObject({ ok: false });
  });

  it("Ampel rot mit Hinweis", () => {
    const ev = evaluatePrescription({ issuedAt: "2026-01-02", urgent: false, units: 2, status: "correction_needed", treatmentDates: ["2026-01-10", "2026-02-10"], today: "2026-11-18" });
    expect(ev.light).toBe("red");
    expect(ev.messages.join(" ")).toMatch(/korrigiert/);
    expect(ev.expiry).toBeNull();
  });
});
