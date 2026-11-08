import { describe, expect, it } from "vitest";
import {
  addMonthsIso,
  batchUsability,
  checklistTaskTitle,
  deadlineStatus,
  needsReorder,
  normalizeBatchCode,
  parseChecklistLines,
  readChecklist,
  safeHttpUrl,
  suggestBatchCode,
  suggestedOrderQty,
  weekStartIso,
  worstDeadline,
} from "./hygiene-rules";

describe("Charge verwendbar?", () => {
  const today = "2026-11-08";
  it("unbekannt", () => expect(batchUsability(null, today)).toEqual({ ok: false, reason: "unknown" }));
  it("gesperrt", () => expect(batchUsability({ result: "rejected", expiresAt: null }, today).reason).toBe("rejected"));
  it("noch nicht freigegeben", () => expect(batchUsability({ result: "pending", expiresAt: "2027-01-01" }, today).reason).toBe("pending"));
  it("unbekannter Status gilt als nicht freigegeben", () => expect(batchUsability({ result: "irgendwas", expiresAt: null }, today).ok).toBe(false));
  it("abgelaufen", () => expect(batchUsability({ result: "released", expiresAt: "2026-11-07" }, today).reason).toBe("expired"));
  it("am Ablauftag noch verwendbar", () => expect(batchUsability({ result: "released", expiresAt: today }, today)).toEqual({ ok: true, reason: null }));
  it("freigegeben ohne Ablauf", () => expect(batchUsability({ result: "released", expiresAt: null }, today).ok).toBe(true));
  it("Sperre geht vor Ablauf", () => expect(batchUsability({ result: "rejected", expiresAt: "2020-01-01" }, today).reason).toBe("rejected"));
});

describe("Chargennummer", () => {
  it("normalisiert Scan/Eingabe", () => expect(normalizeBatchCode("  st-20261108 -01 ")).toBe("ST-20261108-01"));
  it("schlägt die nächste freie Nummer des Tages vor", () => {
    expect(suggestBatchCode("2026-11-08", [])).toBe("ST-20261108-01");
    expect(suggestBatchCode("2026-11-08", ["ST-20261108-01", "st-20261108-07", "ST-20261107-12", "X-1"])).toBe("ST-20261108-08");
  });
});

describe("Fristen-Ampel", () => {
  const today = "2026-11-08";
  it("ohne Datum", () => expect(deadlineStatus(null, today)).toEqual({ status: "none", daysLeft: null }));
  it("überfällig", () => expect(deadlineStatus("2026-11-07", today)).toEqual({ status: "overdue", daysLeft: -1 }));
  it("heute fällig = bald", () => expect(deadlineStatus(today, today)).toEqual({ status: "soon", daysLeft: 0 }));
  it("genau 30 Tage = bald", () => expect(deadlineStatus("2026-12-08", today).status).toBe("soon"));
  it("31 Tage = ok", () => expect(deadlineStatus("2026-12-09", today)).toEqual({ status: "ok", daysLeft: 31 }));
  it("über Sommerzeit-Umstellung exakt", () => expect(deadlineStatus("2027-03-29", "2027-03-27").daysLeft).toBe(2));
  it("schlechteste Ampel", () => {
    expect(worstDeadline([deadlineStatus("2027-06-01", today), deadlineStatus("2026-11-01", today)])).toBe("overdue");
    expect(worstDeadline([deadlineStatus(null, today)])).toBe("none");
  });
  it("Monate addieren (Monatsende)", () => {
    expect(addMonthsIso("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonthsIso("2026-11-08", 6)).toBe("2027-05-08");
  });
});

describe("Checkliste", () => {
  it("Standardliste, wenn nichts gepflegt", () => expect(readChecklist({}).daily.length).toBeGreaterThan(0));
  it("liest gepflegte Liste robust", () => {
    expect(readChecklist({ hygieneChecklist: { daily: ["A", 3, " "], weekly: "kaputt" } })).toEqual({ daily: ["A"], weekly: [] });
  });
  it("Zeilen parsen ohne Dubletten", () => expect(parseChecklistLines("A\n\n B \nA\r\nC")).toEqual(["A", "B", "C"]));
  it("Wochen-Check zählt ab Montag", () => {
    expect(weekStartIso("2026-11-08")).toBe("2026-11-02"); // Sonntag
    expect(weekStartIso("2026-11-02")).toBe("2026-11-02");
    expect(checklistTaskTitle("weekly", "X", "2026-11-05").title).toBe("Wochen-Check 2026-11-02: X");
  });
});

describe("Material", () => {
  it("Bestellliste ab Mindestbestand", () => {
    expect(needsReorder({ stock: 5, minStock: 5 })).toBe(true);
    expect(needsReorder({ stock: 6, minStock: 5 })).toBe(false);
    expect(needsReorder({ stock: 0, minStock: 0 })).toBe(false);
    expect(suggestedOrderQty({ stock: 2, minStock: 5 })).toBe(8);
  });
  it("nur http(s)-Links", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("https://shop.example/p/1")).toBe("https://shop.example/p/1");
  });
});
