import { describe, expect, it } from "vitest";
import {
  DIAGNOSIS_GROUPS,
  addWorkdaysIso,
  anlage3Findings,
  blocksBilling,
  blocksStart,
  frequencyDeviation,
  icdMatchesGroup,
  planningWarnings,
  priceSnapshot,
  START_DEADLINE_DAYS,
  START_DEADLINE_URGENT_DAYS,
  acceptsUnit,
  canTransition,
  copaymentCents,
  evaluatePrescription,
  frequencyWarnings,
  maxGapDays,
  remedyCostCents,
  startDeadline,
  statusAfterUnit,
  validatePrescription,
  autoExpiryApplies,
  exemptionSummary,
  hasAnlage3Fields,
  rulesVersionAtLeast,
  RULES_VERSION,
} from "./prescription";

describe("Behandlungsbeginn-Frist", () => {
  it("28 Tage ab Ausstellung, dringlich 14 Tage", () => {
    expect(START_DEADLINE_DAYS).toBe(28);
    expect(START_DEADLINE_URGENT_DAYS).toBe(14);
    expect(startDeadline("2026-01-01", false)).toBe("2026-01-29");
    expect(startDeadline("2026-01-01", true)).toBe("2026-01-15");
    // über Monats-/Jahresgrenze und Schaltjahr
    expect(startDeadline("2028-02-10", false)).toBe("2028-03-09");
    expect(startDeadline("2026-12-20", true)).toBe("2027-01-03");
  });
});

describe("Frequenz", () => {
  it("versteht übliche Angaben", () => {
    expect(maxGapDays("1x alle 4-6 Wochen")).toBe(42);
    expect(maxGapDays("1x alle 4 Wochen")).toBe(28);
    expect(maxGapDays("1x wöchentlich")).toBe(7);
    expect(maxGapDays("2x/Woche")).toBe(4);
    expect(maxGapDays("1-2x pro Woche")).toBe(7);
    expect(maxGapDays("14-tägig")).toBe(14);
    expect(maxGapDays("nach Bedarf")).toBeNull();
    expect(maxGapDays(null)).toBeNull();
  });

  it("warnt bei zu großen Abständen (mit Toleranz)", () => {
    const dates = ["2026-01-05", "2026-02-10", "2026-04-20"];
    const w = frequencyWarnings(dates, "1x alle 4-6 Wochen");
    // 36 Tage ok, 69 Tage > 42 + 7
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ from: "2026-02-10", to: "2026-04-20", gapDays: 69, allowedDays: 42 });
    expect(frequencyWarnings(dates, "nach Bedarf")).toEqual([]);
  });

  it("prüft laufende Verordnungen auch bis heute", () => {
    expect(frequencyWarnings(["2026-01-05"], "1x alle 4 Wochen", { today: "2026-03-01", running: true })).toHaveLength(1);
    expect(frequencyWarnings(["2026-01-05"], "1x alle 4 Wochen", { today: "2026-03-01", running: false })).toHaveLength(0);
  });
});

describe("Zuzahlung", () => {
  it("10 € + 10 % der Kosten", () => {
    const cost = remedyCostCents([{ units: 6, priceCents: 4250 }, { units: 6, priceCents: 1000 }]);
    expect(cost).toEqual({ cents: 31500, complete: true });
    expect(copaymentCents(cost.cents)).toBe(1000 + 3150);
  });
  it("rundet kaufmännisch", () => {
    expect(copaymentCents(3333)).toBe(1000 + 333);
    expect(copaymentCents(3335)).toBe(1000 + 334);
  });
  it("befreit: Flag oder unter 18", () => {
    expect(copaymentCents(30000, { exempt: true })).toBe(0);
    expect(copaymentCents(30000, { ageYears: 17 })).toBe(0);
    expect(copaymentCents(30000, { ageYears: 18 })).toBe(4000);
  });
  it("meldet fehlende Preise", () => {
    expect(remedyCostCents([{ units: 6, priceCents: null }]).complete).toBe(false);
    expect(remedyCostCents([]).complete).toBe(false);
  });
});

describe("Status", () => {
  it("open → active → completed → billing_ready → billed", () => {
    expect(statusAfterUnit("open", 1, 6)).toBe("active");
    expect(statusAfterUnit("active", 5, 6)).toBe("active");
    expect(statusAfterUnit("active", 6, 6)).toBe("completed");
    expect(statusAfterUnit("billing_ready", 6, 6)).toBe("billing_ready");
    expect(canTransition("completed", "billing_ready", { unitsUsed: 6, units: 6 }).ok).toBe(true);
    expect(canTransition("billing_ready", "billed", { unitsUsed: 6, units: 6 }).ok).toBe(true);
  });
  it("verbietet unzulässige Wechsel", () => {
    expect(canTransition("billed", "open").ok).toBe(false);
    expect(canTransition("open", "billing_ready").ok).toBe(false);
    expect(canTransition("cancelled", "active").ok).toBe(false);
  });
  it("vorzeitige Abrechnung nur mit Begründung", () => {
    expect(canTransition("active", "billing_ready", { unitsUsed: 3, units: 6 }).ok).toBe(false);
    expect(canTransition("active", "billing_ready", { unitsUsed: 3, units: 6, interruptionNote: "Patient verstorben" }).ok).toBe(true);
    expect(canTransition("active", "completed", { unitsUsed: 3, units: 6 }).ok).toBe(false);
    expect(canTransition("active", "completed", { unitsUsed: 6, units: 6 }).ok).toBe(true);
  });
  it("nimmt Einheiten nur bei offenen/aktiven VOs mit Rest an", () => {
    expect(acceptsUnit("open", 0, 6)).toBe(true);
    expect(acceptsUnit("active", 6, 6)).toBe(false);
    expect(acceptsUnit("billing_ready", 2, 6)).toBe(false);
  });
});

describe("Eingabeprüfung", () => {
  const base = { issuedAt: "2026-11-01", diagnosisGroup: "DF", units: 6, icd10: "E11.74", today: "2026-11-08", positions: [{ label: "Podologische Komplexbehandlung", units: 6 }] };
  it("akzeptiert gültige Verordnung", () => {
    expect(validatePrescription(base)).toEqual({ errors: [], warnings: [] });
  });
  it("findet Fehler und Warnungen", () => {
    expect(validatePrescription({ ...base, issuedAt: "2026-12-01" }).errors).toHaveLength(1);
    expect(validatePrescription({ ...base, positions: [] }).errors).toHaveLength(1);
    expect(validatePrescription({ ...base, positions: [{ label: "X", units: 7 }] }).errors).toHaveLength(1);
    expect(validatePrescription({ ...base, diagnosisGroup: "XY" }).errors).toContain("Unbekannte Diagnosegruppe.");
    expect(validatePrescription({ ...base, units: 10, positions: [{ label: "X", units: 10 }] }).warnings[0]).toMatch(/Höchstmenge/);
    expect(validatePrescription({ ...base, icd10: null }).warnings[0]).toMatch(/ICD-10/);
  });
});

describe("Ampel", () => {
  const vo = { issuedAt: "2026-11-01", urgent: false, units: 6, status: "open", frequency: "1x alle 4-6 Wochen", treatmentDates: [] as string[] };
  it("grün, solange die Frist weit weg ist", () => {
    const e = evaluatePrescription({ ...vo, today: "2026-11-05" });
    expect(e).toMatchObject({ light: "green", startState: "ok", startBy: "2026-11-29", unitsRemaining: 6 });
  });
  it("gelb kurz vor Fristende, rot danach", () => {
    expect(evaluatePrescription({ ...vo, today: "2026-11-26" }).light).toBe("yellow");
    expect(evaluatePrescription({ ...vo, today: "2026-11-30" })).toMatchObject({ light: "red", startState: "missed" });
  });
  it("zählt Einheiten und meldet die letzte", () => {
    const e = evaluatePrescription({ ...vo, status: "active", treatmentDates: ["2026-11-02", "2026-12-01", "2027-01-05", "2027-02-02", "2027-03-01"], today: "2027-03-02" });
    expect(e.unitsUsed).toBe(5);
    expect(e.unitsRemaining).toBe(1);
    expect(e.light).toBe("yellow");
  });
  it("blau = abrechnungsreif", () => {
    expect(evaluatePrescription({ ...vo, status: "billing_ready", treatmentDates: ["2026-11-02"], today: "2027-06-01" }).light).toBe("blue");
  });
});

describe("Paket A: Fristen, Frequenz, Zuzahlung je Tag, Anlage 3", () => {
  it("UI2: Höchstmenge 4 je Verordnung (Heilmittelkatalog)", () => {
    expect(DIAGNOSIS_GROUPS.UI2.maxUnitsPerPrescription).toBe(4);
    expect(DIAGNOSIS_GROUPS.UI1.maxUnitsPerPrescription).toBe(8);
  });
  it("Werktage Mo–Sa", () => {
    expect(addWorkdaysIso("2026-11-13", 2)).toBe("2026-11-16"); // Fr → Sa, (So), Mo
    expect(addWorkdaysIso("2026-11-16", -2)).toBe("2026-11-13");
  });
  it("Frequenzabweichung über ± 2 Werktage braucht Begründung (Vertrag § 7 Abs. 6)", () => {
    const base = { group: "DF", frequency: "1x alle 4-6 Wochen", lastDate: "2026-10-01" };
    expect(frequencyDeviation({ ...base, date: "2026-10-29" })).toBeNull(); // genau 4 Wochen
    expect(frequencyDeviation({ ...base, date: "2026-10-27" })).toBeNull(); // 2 Werktage früher
    expect(frequencyDeviation({ ...base, date: "2026-10-26" })).toMatchObject({ kind: "under" });
    expect(frequencyDeviation({ ...base, date: "2026-11-14" })).toBeNull(); // 6 Wochen + 2 Werktage
    expect(frequencyDeviation({ ...base, date: "2026-11-16" })).toMatchObject({ kind: "over" });
  });
  it("ohne Frequenz gilt die Katalog-Frequenz, UI nur Empfehlung, erste Behandlung nie", () => {
    expect(frequencyDeviation({ group: "NF", frequency: null, lastDate: "2026-10-01", date: "2026-10-05" })).toMatchObject({ kind: "under" });
    expect(frequencyDeviation({ group: "UI1", frequency: "1x wöchentlich", lastDate: "2026-10-01", date: "2026-12-01" })).toBeNull();
    expect(frequencyDeviation({ group: "DF", frequency: "1x alle 4-6 Wochen", lastDate: null, date: "2026-12-01" })).toBeNull();
  });
  it("12 Wochen Unterbrechung → Frist überschritten (Vertrag § 7 Abs. 7)", () => {
    const vo = { issuedAt: "2026-01-01", urgent: false, units: 6, status: "active", frequency: "1x alle 4-6 Wochen", treatmentDates: ["2026-01-10"] };
    expect(evaluatePrescription({ ...vo, today: "2026-04-04" }).expiry).toBeNull(); // 84 Tage
    expect(evaluatePrescription({ ...vo, today: "2026-04-05" })).toMatchObject({ expiry: "interrupted", light: "red" });
    expect(evaluatePrescription({ ...vo, status: "open", treatmentDates: [], today: "2026-01-30" }).expiry).toBe("start_missed");
  });
  it("Preis-Snapshot: Zuzahlung je Behandlungstag, Volljährigkeit am Behandlungstag, Gebühr nach erstem Tag", () => {
    const positions = [{ position: "78020", label: "groß", units: 3 }];
    // wird am 2026-08-02 18 Jahre alt
    const snap = priceSnapshot({ positions, treatmentDates: ["2026-07-20", "2026-08-02", "2026-09-01"], birthDate: "2008-08-02", exemptions: [], computedOn: "2026-09-02" });
    expect(snap.remedyCents).toBe(3 * 5192);
    expect(snap.lines.map((l) => l.minor)).toEqual([true, false, false]);
    expect(snap.copaymentPercentCents).toBe(2 * 519);
    // erster Behandlungstag minderjährig → keine Verordnungsblattgebühr (Vertrag § 8 Abs. 2 Satz 3)
    expect(snap.flatFeeCents).toBe(0);
    expect(snap.complete).toBe(true);
  });
  it("Preis-Snapshot: Befreiung gilt je Tag (Kalenderjahr), Deckel bei den Kosten", () => {
    const positions = [{ position: "78030", label: "Befundung", units: 2 }];
    const exemptions = [{ validFrom: "2026-01-01", validTo: "2026-12-31" }];
    const snap = priceSnapshot({ positions, treatmentDates: ["2026-12-20", "2027-01-10"], birthDate: "1950-01-01", exemptions, computedOn: "2027-01-11" });
    expect(snap.lines.map((l) => l.exempt)).toEqual([true, false]);
    expect(snap.flatFeeCents).toBe(0); // erster Tag befreit
    expect(snap.copaymentPercentCents).toBe(36);
    // ohne Befreiung: 10 € Gebühr, aber höchstens die Kosten (2 × 3,57 €)
    const capped = priceSnapshot({ positions, treatmentDates: ["2026-12-20", "2027-01-10"], birthDate: "1950-01-01", exemptions: [], computedOn: "2027-01-11" });
    expect(capped.copaymentCents).toBe(714);
  });
  it("Preis-Snapshot meldet fehlende Preise", () => {
    const snap = priceSnapshot({ positions: [{ position: "78020", label: "x", units: 1 }], treatmentDates: ["2025-06-01"], birthDate: "1950-01-01", exemptions: [], computedOn: "2025-06-02" });
    expect(snap.complete).toBe(false);
    expect(snap.notes[0]).toMatch(/Kein Preis/);
  });
  it("ICD-10 ↔ Diagnosegruppe", () => {
    expect(icdMatchesGroup("DF", "E11.74")).toBe("ok");
    expect(icdMatchesGroup("DF", "E10.40")).toBe("ok");
    expect(icdMatchesGroup("DF", "G63.2*")).toBe("ok");
    expect(icdMatchesGroup("DF", "E11.9")).toBe("check");
    expect(icdMatchesGroup("UI1", "L60.0")).toBe("ok");
    expect(icdMatchesGroup("UI2", "L60.1")).toBe("wrong");
    expect(icdMatchesGroup("NF", "G60.0")).toBe("ok");
  });
  it("Anlage 3: vollständige Verordnung ohne Befunde, fehlende Pflichtangaben je Stufe", () => {
    const ok = {
      diagnosisGroup: "DF", issuedAt: "2026-11-01", units: 6, icd10: "E11.74", leitsymptomatik: "c", frequency: "1x alle 4-6 Wochen",
      positions: [{ position: "78020", label: "groß", units: 6 }], homeVisit: false, insurerIk: "109911114", insuranceNumber: "A000500015",
      insuredStatus: "1", doctorLanr: "123456601", doctorBsnr: "123456789", doctorSigned: true, practiceIk: "109911114",
    };
    expect(anlage3Findings(ok)).toEqual([]);
    const levels = (v: Partial<Omit<typeof ok, "doctorSigned">> & { doctorSigned?: boolean | null }) => Object.fromEntries(anlage3Findings({ ...ok, ...v }).map((f) => [f.code, f.level]));
    expect(levels({ insuranceNumber: "" })).toEqual({ kvnr_missing: "start" });
    expect(levels({ insurerIk: "" })).toEqual({ insurer_ik_missing: "start" });
    expect(levels({ doctorLanr: "" })).toEqual({ lanr_missing: "start" });
    expect(levels({ doctorSigned: false })).toEqual({ signature_missing: "start" });
    expect(levels({ icd10: "" })).toEqual({ diagnosis_missing: "start" });
    expect(levels({ insuredStatus: "" })).toEqual({ status_missing: "warning" });
    expect(levels({ doctorBsnr: "" })).toEqual({ bsnr_missing: "warning" });
    expect(levels({ doctorLanr: "123456701" })).toEqual({ lanr_check: "warning" });
    expect(levels({ insuranceNumber: "A000500016" })).toEqual({ kvnr_check: "warning" });
    expect(levels({ insurerIk: "109911115" })).toEqual({ insurer_ik_check: "billing" });
    expect(levels({ icd10: "E11.9" })).toEqual({ icd_group: "warning" });
    expect(levels({ leitsymptomatik: "" })).toEqual({ leitsymptomatik_missing: "warning" });
    expect(levels({ frequency: "" })).toEqual({ frequency_missing: "warning" });
    expect(levels({ practiceIk: "" })).toEqual({ practice_ik_missing: "billing" });
    expect(levels({ positions: [{ position: "79933", label: "HB", units: 6 }] })).toEqual({ home_visit: "billing" });
    expect(levels({ diagnosisGroup: "UI1", icd10: "L60.1", positions: [{ position: "78610", label: "Spange", units: 6 }] })).toEqual({ icd_group: "billing" });
    expect(levels({ positions: [{ position: "78610", label: "Spange", units: 6 }] })).toEqual({ position_group: "billing" });
    expect(levels({ units: 8 })).toEqual({ units_max: "warning" });
    expect(levels({ doctorSigned: null })).toEqual({});
    expect(blocksStart(anlage3Findings({ ...ok, doctorSigned: false }))).toBe(true);
    expect(blocksBilling(anlage3Findings({ ...ok, practiceIk: "" }))).toBe(true);
    expect(blocksBilling(anlage3Findings({ ...ok, insuredStatus: "" }))).toBe(false);
  });
  it("Terminplanung: Restmenge inkl. geplanter Termine, Frist, Frequenz", () => {
    const base = { group: "DF", frequency: "1x alle 4-6 Wochen", urgent: false, issuedAt: "2026-11-01", units: 6 };
    expect(planningWarnings({ ...base, treatmentDates: [], plannedDates: [], newDates: ["2026-11-10"] })).toEqual([]);
    expect(planningWarnings({ ...base, treatmentDates: [], plannedDates: [], newDates: ["2026-12-01"] })[0]).toMatch(/spätesten Behandlungsbeginn/);
    expect(planningWarnings({ ...base, treatmentDates: ["2026-11-05", "2026-12-03", "2027-01-07", "2027-02-04"], plannedDates: ["2027-03-04"], newDates: ["2027-04-01", "2027-04-29"] })[0]).toMatch(/Nur noch 1 von 6/);
    expect(planningWarnings({ ...base, treatmentDates: ["2026-11-05"], plannedDates: [], newDates: ["2026-11-12"] })[0]).toMatch(/Frequenz unterschritten/);
    expect(planningWarnings({ ...base, treatmentDates: ["2026-11-05"], plannedDates: [], newDates: ["2027-02-01"] }).join(" ")).toMatch(/12 Wochen/);
  });
});

describe("Review-Runde 1 PR #111", () => {
  it("C3/C1: Anlage-3-Prüfung und Auto-Ablauf ab Mindest-Regelwerk, nicht für Altbestand/Import", () => {
    expect(hasAnlage3Fields(RULES_VERSION)).toBe(true);
    expect(hasAnlage3Fields("podo-2027-07-anlage3-2027-07")).toBe(true);
    expect(rulesVersionAtLeast("podo-2026-10-x")).toBe(false);
    expect(hasAnlage3Fields("heilm-rl-podo-2025-07-entwurf")).toBe(false);
    expect(autoExpiryApplies("import-tinana")).toBe(false);
    expect(autoExpiryApplies(null)).toBe(false);
  });
  it("C1: „in Behandlung“ ohne erfassten Behandlungstag (Übernahme) → Beginnfrist nicht verpasst", () => {
    const ev = evaluatePrescription({ issuedAt: "2026-01-01", urgent: false, units: 6, status: "active", treatmentDates: [], today: "2026-11-17" });
    expect(ev.expiry).toBeNull();
    expect(ev.startState).toBe("started");
    const open = evaluatePrescription({ issuedAt: "2026-01-01", urgent: false, units: 6, status: "open", treatmentDates: [], today: "2026-11-17" });
    expect(open.expiry).toBe("start_missed");
  });
  it("C1: Wiederaufnahme bestätigt den Beginn, Unterbrechung zählt ab Wiederaufnahme; Rückweg nur mit Begründung", () => {
    const ev = evaluatePrescription({ issuedAt: "2026-01-01", urgent: false, units: 6, status: "open", treatmentDates: [], today: "2026-11-17", reopenedOn: "2026-11-10" });
    expect(ev.expiry).toBeNull();
    const old = evaluatePrescription({ issuedAt: "2026-01-01", urgent: false, units: 6, status: "active", treatmentDates: ["2026-02-01"], today: "2026-11-17", reopenedOn: "2026-11-10" });
    expect(old.expiry).toBeNull();
    const later = evaluatePrescription({ issuedAt: "2026-01-01", urgent: false, units: 6, status: "active", treatmentDates: ["2026-02-01"], today: "2027-03-01", reopenedOn: "2026-11-10" });
    expect(later.expiry).toBe("interrupted");
    expect(canTransition("expired", "open", {}).ok).toBe(false);
    expect(canTransition("expired", "open", { interruptionNote: "Beginn war rechtzeitig" }).ok).toBe(true);
    expect(canTransition("expired", "open", { interruptionNote: "Beginn war rechtzeitig", unitsUsed: 1, units: 6 }).ok).toBe(false);
    expect(canTransition("expired", "active", { interruptionNote: "Beginn war rechtzeitig", unitsUsed: 6, units: 6 }).ok).toBe(false);
    expect(canTransition("expired", "billing_ready", { interruptionNote: "Beginn war rechtzeitig" }).ok).toBe(false);
  });
  it("C5: zwei Einträge am selben Tag sind keine Frequenzabweichung", () => {
    expect(frequencyDeviation({ group: "DF", frequency: "1x alle 4-6 Wochen", lastDate: "2026-11-17", date: "2026-11-17" })).toBeNull();
    expect(frequencyDeviation({ group: "DF", frequency: "1x alle 4-6 Wochen", lastDate: "2026-11-16", date: "2026-11-17" })?.kind).toBe("under");
  });
  it("S3: 78610 bis zu zweimal je Tag, Preisstand je Tag", () => {
    const snap = priceSnapshot({ positions: [{ position: "78610", label: "Spange", units: 4 }], treatmentDates: ["2026-06-20", "2026-07-02"], birthDate: "1950-01-01", exemptions: [], computedOn: "2026-07-03" });
    expect(snap.lines.map((l) => [l.date, l.units, l.tableVersion])).toEqual([
      ["2026-06-20", 2, "podo-anlage2-2025-07-01"],
      ["2026-07-02", 2, "podo-anlage2-2026-07-01"],
    ]);
    expect(snap.remedyCents).toBe(2 * 5590 + 2 * 5720);
    expect(snap.copaymentPercentCents).toBe(2 * 559 + 2 * 572);
    // andere Positionen: höchstens eine je Tag (wie bisher)
    const one = priceSnapshot({ positions: [{ position: "78020", label: "groß", units: 4 }], treatmentDates: ["2026-07-20", "2026-08-20"], birthDate: "1950-01-01", exemptions: [], computedOn: "2026-08-21" });
    expect(one.lines.map((l) => l.units)).toEqual([1, 1]);
  });
  it("S2: keine Verordnungsblattgebühr, wenn der erste Behandlungstag keinen Preis hat; Snapshot unvollständig", () => {
    const snap = priceSnapshot({ positions: [{ position: "78020", label: "groß", units: 2 }], treatmentDates: ["2025-06-20", "2025-07-20"], birthDate: "1950-01-01", exemptions: [], computedOn: "2025-07-21" });
    expect(snap.complete).toBe(false);
    expect(snap.flatFeeCents).toBe(0);
  });
  it("B1: Befreiung je Tag für den Export; Befreiung einer anderen Kasse → Hinweis", () => {
    const positions = [{ position: "78020", label: "groß", units: 3 }];
    const exemptions = [{ validFrom: "2026-01-01", validTo: "2026-12-31", insurerIk: "109911114" }];
    expect(exemptionSummary(priceSnapshot({ positions, treatmentDates: ["2026-11-02", "2026-12-14"], birthDate: "1950-01-01", exemptions, computedOn: "2026-12-15" }))).toBe("ja");
    expect(exemptionSummary(priceSnapshot({ positions, treatmentDates: ["2026-11-02"], birthDate: "1950-01-01", exemptions: [], computedOn: "2026-12-15" }))).toBe("nein");
    expect(exemptionSummary(priceSnapshot({ positions, treatmentDates: ["2026-11-02"], birthDate: "2015-01-01", exemptions: [], computedOn: "2026-12-15" }))).toBe("minderjährig");
    expect(exemptionSummary(priceSnapshot({ positions, treatmentDates: ["2026-12-14", "2027-01-11"], birthDate: "1950-01-01", exemptions, computedOn: "2027-01-12" }))).toBe("gemischt (14.12.2026 befreit | 11.01.2027 pflichtig)");
    expect(exemptionSummary(null)).toBe("");
    const other = priceSnapshot({ positions, treatmentDates: ["2026-11-02"], birthDate: "1950-01-01", exemptions, computedOn: "2026-11-03", insurerIk: "108310400" });
    expect(other.notes.join(" ")).toMatch(/anderen Krankenkasse/);
  });
  it("Planung: Übernahme/Wiederaufnahme ohne Beginnfrist-Warnung", () => {
    const base = { group: "DF", frequency: "1x alle 4-6 Wochen", urgent: false, issuedAt: "2026-01-01", units: 6, treatmentDates: [], plannedDates: [], newDates: ["2026-11-20"] };
    expect(planningWarnings(base).join(" ")).toMatch(/spätesten Behandlungsbeginn/);
    expect(planningWarnings({ ...base, started: true })).toEqual([]);
    expect(planningWarnings({ ...base, reopenedOn: "2026-11-17", started: true, newDates: ["2027-03-01"] }).join(" ")).toMatch(/Wiederaufnahme/);
  });
  it("Zuzahlung je Zeile: null bei Position ohne Zuzahlung laut Anlage 2 (78530), 0 bei unter 18/befreit", () => {
    // Paket B: 78530 mit dem Berichtsdatum (am selben Tag nach den Behandlungspositionen)
    const snap = priceSnapshot({ positions: [{ position: "78530", label: "Therapiebericht", units: 1 }, { position: "78610", label: "Spange", units: 1 }], treatmentDates: ["2026-11-02"], birthDate: "1950-01-01", exemptions: [], computedOn: "2026-11-03", therapyReportDate: "2026-11-02" });
    expect(snap.lines.map((l) => [l.position, l.copayCents])).toEqual([["78610", 572], ["78530", null]]);
    expect(snap.copaymentPercentCents).toBe(572);
    const minor = priceSnapshot({ positions: [{ position: "78530", label: "Therapiebericht", units: 1 }, { position: "78610", label: "Spange", units: 1 }], treatmentDates: ["2026-11-02"], birthDate: "2015-01-01", exemptions: [], computedOn: "2026-11-03", therapyReportDate: "2026-11-02" });
    expect(minor.lines.map((l) => l.copayCents)).toEqual([0, null]);
    expect(minor.copaymentCents).toBe(0);
  });
});
