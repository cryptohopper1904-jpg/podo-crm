import { describe, expect, it } from "vitest";
import { copaymentPaidHint, evaluatePrescription, mergePositions, preparePositions, priceSnapshot } from "./prescription";

/** PR #111 „GKV-Grundlagen“, Review-Runde 3 (Nachprüfung Code, AppSec, Buchhaltung) – docs/GKV.md */
describe("Review-Runde 3 PR #111", () => {
  const old = { birthDate: "1950-01-01", exemptions: [] };
  const keys = (lines: { date: string; position: string }[]) => lines.map((l) => `${l.date}|${l.position}`);

  it("B1 Fall H: zwei Einträge am selben Tag (78010 × 2) → EINE Zeile, nur 1 Einheit abrechenbar (Tageshöchstmenge 1), Hinweis", () => {
    const snap = priceSnapshot({ positions: [{ position: "78010", label: "klein", units: 2 }], treatmentDates: ["2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(snap.lines).toHaveLength(1);
    expect(snap.lines[0]).toMatchObject({ date: "2026-11-02", position: "78010", units: 1, copayCents: 361 });
    expect(snap.remedyCents).toBe(3610);
    expect(snap.notes).toContain("2 Behandlungseinträge am 02.11.2026 – nur 1 Einheit 78010 abrechenbar, bitte prüfen.");
    expect(snap.notes.join(" ")).toMatch(/1 Einheit 78010 nicht verteilbar/);
    expect(new Set(keys(snap.lines)).size).toBe(snap.lines.length);
  });

  it("B1 Fall I: doppelte Position auf der VO (auch KH/KB-Nummer) → zusammengefasst, Hinweis „doppelte Position“, keine doppelten Zeilen", () => {
    const snap = priceSnapshot({
      positions: [{ position: "78010", label: "klein", units: 1 }, { position: "68010", label: "klein (KH)", units: 1 }],
      treatmentDates: ["2026-11-02", "2026-11-30"],
      ...old,
      computedOn: "2026-12-01",
    });
    expect(keys(snap.lines)).toEqual(["2026-11-02|78010", "2026-11-30|78010"]);
    expect(snap.lines.map((l) => l.units)).toEqual([1, 1]);
    expect(snap.notes.join(" ")).toMatch(/Position 78010 steht mehrfach auf der Verordnung – zusammengefasst \(2 Einheiten\)/);
    expect(snap.notes.join(" ")).not.toMatch(/zwei Behandlungseinträge/);
  });

  it("B1: Zuzahlung je Zeile bleibt null (Position ohne Zuzahlung) auch bei zwei Einträgen am selben Tag (Runde 4: 1 Einheit je Tag)", () => {
    const snap = priceSnapshot({ positions: [{ position: "78530", label: "Therapiebericht", units: 2 }], treatmentDates: ["2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(snap.lines).toEqual([expect.objectContaining({ units: 1, copayCents: null })]);
  });

  it("H-3/S5: mergePositions fasst ZL/KH/KB-Nummern derselben Leistung zusammen", () => {
    expect(mergePositions([{ position: "78020", label: "ZL", units: 1 }, { position: "88020", label: "KB", units: 2 }, { position: "68020", label: "KH", units: 3 }])).toEqual([{ position: "78020", label: "ZL", units: 6 }]);
  });

  it("H-2: Positionen erst prüfen (Einheiten ≥ 1 je Zeile), dann zusammenfassen – [5, −3] wird abgelehnt", () => {
    expect(preparePositions([{ position: "78020", label: "groß", units: 5 }, { position: "78020", label: "groß", units: -3 }])).toEqual({ error: expect.stringMatching(/Einheiten/) });
    expect(preparePositions([{ position: "78020", label: "groß", units: 1.5 }])).toEqual({ error: expect.stringMatching(/Einheiten/) });
    expect(preparePositions([{ position: "78020", label: "groß", units: 2 }, { position: "78020", label: "groß", units: 3 }, { label: "", units: 0 }])).toEqual({ positions: [{ position: "78020", label: "groß", units: 5 }] });
  });

  it("S1: gedeckelte Pauschale steht als Hinweis im Snapshot", () => {
    const snap = priceSnapshot({ positions: [{ position: "78030", label: "Befundung", units: 1 }], treatmentDates: ["2026-03-02"], ...old, computedOn: "2026-03-03" });
    expect(snap.notes).toContain("Pauschale auf 3,12 € gedeckelt (Kosten 3,47 € − 10 % 0,35 €).");
    const big = priceSnapshot({ positions: [{ position: "78020", label: "groß", units: 1 }], treatmentDates: ["2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(big.notes.join(" ")).not.toMatch(/gedeckelt/);
  });

  it("S4: Hinweis bei Unter- und Überzahlung der Zuzahlung", () => {
    expect(copaymentPaidHint(1506, 1519)).toBe("Restbetrag 0,13 € offen.");
    expect(copaymentPaidHint(1519, 1519)).toBeNull();
    expect(copaymentPaidHint(2000, 1519)).toMatch(/über der berechneten Zuzahlung/);
    expect(copaymentPaidHint(null, 1519)).toBeNull();
  });

  it("H-6: Bezugspunkt der Unterbrechung kommt aus der Bewertung", () => {
    const imported = evaluatePrescription({ issuedAt: "2026-08-01", urgent: false, units: 6, status: "active", treatmentDates: [], rulesVersion: "import-tinana", importedOn: "2026-08-01", today: "2026-11-17" });
    expect(imported.interruptionSince).toEqual({ label: "der Übernahme in PodoHero", date: "2026-08-01" });
    const reopened = evaluatePrescription({ issuedAt: "2026-01-01", urgent: false, units: 6, status: "active", treatmentDates: ["2026-02-01"], reopenedOn: "2026-03-01", today: "2026-11-17" });
    expect(reopened.interruptionSince).toEqual({ label: "der Wiederaufnahme", date: "2026-03-01" });
    const normal = evaluatePrescription({ issuedAt: "2026-01-01", urgent: false, units: 6, status: "active", treatmentDates: ["2026-02-01"], today: "2026-11-17" });
    expect(normal.interruptionSince).toEqual({ label: "der letzten Behandlung", date: "2026-02-01" });
  });
});
