import { describe, expect, it } from "vitest";
import { RULES_VERSION, autoExpiryApplies, canTransition, copaymentOverpaid, evaluatePrescription, mergePositions, priceSnapshot } from "./prescription";

/** PR #111 „GKV-Grundlagen“, Review-Runde 2 (Code, AppSec, Buchhaltung) – docs/GKV.md */
describe("Review-Runde 2 PR #111", () => {
  const old = { birthDate: "1950-01-01", exemptions: [] };

  it("Pauschale gedeckelt: Zuzahlung = 10-%-Anteil + Pauschale ≤ Kosten (nur 78030, 3,47 €)", () => {
    const snap = priceSnapshot({ positions: [{ position: "78030", label: "Befundung", units: 1 }], treatmentDates: ["2026-03-02"], ...old, computedOn: "2026-03-03" });
    expect(snap.remedyCents).toBe(347);
    expect(snap.copaymentPercentCents).toBe(35);
    expect(snap.flatFeeCents).toBe(312);
    expect(snap.copaymentCents).toBe(snap.copaymentPercentCents + snap.flatFeeCents);
    expect(snap.copaymentCents).toBe(347);
    // ausreichend hohe Kosten: volle 10 €
    const big = priceSnapshot({ positions: [{ position: "78020", label: "groß", units: 1 }], treatmentDates: ["2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(big.flatFeeCents).toBe(1000);
    expect(big.copaymentCents).toBe(big.copaymentPercentCents + 1000);
  });

  it("78610: Annahme „2 × am Tag“ und nicht verteilbare Einheiten stehen in den Hinweisen", () => {
    const snap = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 5 }], treatmentDates: ["2026-11-02", "2026-11-09"], ...old, computedOn: "2026-11-10" });
    expect(snap.lines.map((l) => l.units)).toEqual([2, 2]);
    expect(snap.notes).toContain("2 × 78610 am 02.11.2026 angenommen – bitte mit Doku abgleichen.");
    expect(snap.notes).toContain("2 × 78610 am 09.11.2026 angenommen – bitte mit Doku abgleichen.");
    expect(snap.notes.join(" ")).toMatch(/1 Einheit 78610 nicht verteilbar/);
  });

  it("78610: vorzeitig beendete Verordnung → nur eine je Tag", () => {
    const snap = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 4 }], treatmentDates: ["2026-11-02", "2026-11-09"], ...old, computedOn: "2026-11-10", endedEarly: true });
    expect(snap.lines.map((l) => l.units)).toEqual([1, 1]);
    expect(snap.notes.join(" ")).not.toMatch(/angenommen/);
    expect(snap.notes.join(" ")).toMatch(/2 Einheiten 78610 nicht verteilbar \(2 Behandlungstage, vorzeitig beendet\)/);
    expect(snap.remedyCents).toBe(2 * 5720);
  });

  it("zwei Behandlungseinträge am selben Tag → Hinweis, nicht blockierend", () => {
    const snap = priceSnapshot({ positions: [{ position: "78020", label: "groß", units: 2 }], treatmentDates: ["2026-11-02", "2026-11-02"], ...old, computedOn: "2026-11-03" });
    expect(snap.complete).toBe(true);
    expect(snap.notes).toContain("Zwei Einheiten 78020 am 02.11.2026 (zwei Behandlungseinträge) – bitte prüfen, ob abrechenbar.");
    const ok = priceSnapshot({ positions: [{ position: "78020", label: "groß", units: 2 }], treatmentDates: ["2026-11-02", "2026-11-30"], ...old, computedOn: "2026-12-01" });
    expect(ok.notes).toEqual([]);
  });

  it("doppelte Positionsnummern werden zusammengefasst (Einheiten addiert)", () => {
    expect(
      mergePositions([
        { position: "78020", label: "groß", units: 2 },
        { position: "78030", label: "Befundung", units: 1 },
        { position: "78020", label: "groß (2)", units: 3 },
        { label: "ohne Nummer", units: 1 },
        { label: "ohne Nummer", units: 1 },
      ]),
    ).toEqual([
      { position: "78020", label: "groß", units: 5 },
      { position: "78030", label: "Befundung", units: 1 },
      { label: "ohne Nummer", units: 1 },
      { label: "ohne Nummer", units: 1 },
    ]);
    const input = [{ position: "78020", label: "a", units: 1 }, { position: "78020", label: "b", units: 1 }];
    mergePositions(input);
    expect(input[0].units).toBe(1); // Eingabe bleibt unverändert
  });

  it("S-1: neue VO „offen“ → „in Behandlung“ ohne Einheit abgelehnt; Gegenbeispiel bleibt start_missed", () => {
    const vo = { issuedAt: "2026-09-01", urgent: false, units: 6, treatmentDates: [], today: "2026-11-17", rulesVersion: RULES_VERSION };
    expect(evaluatePrescription({ ...vo, status: "open" }).expiry).toBe("start_missed");
    expect(canTransition("open", "active", { unitsUsed: 0, units: 6, rulesVersion: RULES_VERSION }).ok).toBe(false);
    // selbst wenn der Status (z. B. per Altdaten) „in Behandlung“ wäre: keine Übernahme → Frist bleibt verpasst
    const active = evaluatePrescription({ ...vo, status: "active" });
    expect(active.startState).toBe("missed");
    expect(active.expiry).toBe("start_missed");
    // Übernahme/Altbestand: weiterhin „anderswo begonnen“
    expect(evaluatePrescription({ ...vo, status: "active", rulesVersion: "import-tinana" }).expiry).toBeNull();
    expect(canTransition("open", "active", { unitsUsed: 0, units: 6, rulesVersion: "import-tinana" }).ok).toBe(true);
    // Wiederaufnahme ohne Einheit nur nach „offen“
    expect(canTransition("expired", "active", { unitsUsed: 0, units: 6, interruptionNote: "Beginn war rechtzeitig", rulesVersion: RULES_VERSION }).ok).toBe(false);
    expect(canTransition("expired", "open", { unitsUsed: 0, units: 6, interruptionNote: "Beginn war rechtzeitig", rulesVersion: RULES_VERSION }).ok).toBe(true);
  });

  it("S-2: Übernahme „in Behandlung“ ohne erfassten Tag → gelb, Unterbrechung ab Übernahmedatum, nach 12 Wochen ungültig", () => {
    const vo = { issuedAt: "2026-08-01", urgent: false, units: 6, status: "active", treatmentDates: [] as string[], rulesVersion: "import-tinana", importedOn: "2026-09-01" };
    const now = evaluatePrescription({ ...vo, today: "2026-09-10" });
    expect(now.expiry).toBeNull();
    expect(now.light).toBe("yellow");
    expect(now.interruptionBy).toBe("2026-11-24");
    expect(now.messages[0]).toMatch(/Übernommene Verordnung ohne erfassten Behandlungstag.*01\.09\.2026/);
    const late = evaluatePrescription({ ...vo, today: "2026-11-25" });
    expect(late.expiry).toBe("interrupted");
    expect(late.light).toBe("red");
    expect(late.messages.join(" ")).toMatch(/Seit der Übernahme in PodoHero \(01\.09\.2026\) mehr als 12 Wochen/);
    // kein automatischer Ablauf für Übernahmen (expireOverdue prüft autoExpiryApplies)
    expect(autoExpiryApplies(vo.rulesVersion)).toBe(false);
    // mit erfasster Behandlung zählt wieder die letzte Behandlung
    expect(evaluatePrescription({ ...vo, treatmentDates: ["2026-10-01"], today: "2026-11-25" }).expiry).toBeNull();
  });

  it("Zuzahlung erhalten: Hinweis bei Betrag über der berechneten Zuzahlung", () => {
    expect(copaymentOverpaid(1250, 1519)).toBeNull();
    expect(copaymentOverpaid(1519, 1519)).toBeNull();
    expect(copaymentOverpaid(12500, 1519)).toMatch(/125,00 €.*15,19 €/);
    expect(copaymentOverpaid(null, 1519)).toBeNull();
    expect(copaymentOverpaid(100, null)).toBeNull();
  });
});
