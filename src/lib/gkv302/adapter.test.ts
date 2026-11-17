import { describe, expect, it } from "vitest";
import { bildeAbrechnungsfall, type PodoHeroBehandlung, type PodoHeroPatient, type PodoHeroVerordnung } from "./adapter";

const vo: PodoHeroVerordnung = { id: "v1", issuedAt: "2026-10-01", diagnosisGroup: "DF", icd10: "E11.74", homeVisit: false, urgent: false, copaymentExempt: false, therapyReportRequested: false, source: "paper" };
const patient = (birthDate: string): PodoHeroPatient => ({ lastName: "Test", firstName: "Toni", birthDate, insuranceNumber: "X000000003", insuranceStatus: "1000000", insurerIk: "990020015" });
const behandlungen: PodoHeroBehandlung[] = [
  { date: "2026-10-05", position: "99901", units: 1, priceCents: 3555 },
  { date: "2026-10-19", position: "99901", units: 1, priceCents: 3555 },
];
const ergaenzung = { verordnungsart: "03" as const, leitsymptomatik: { art: "heilmittelrichtlinie" as const, a: true, b: false, c: false, patientenindividuell: false } };

describe("B4 Zuzahlungskennzeichen im Adapter (Anlage 3 8.1.3; § 32 Abs. 2 SGB V)", () => {
  it("unter 18 an allen Behandlungstagen → ZK 0 (keine gesetzliche Zuzahlung)", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2010-03-15"), behandlungen, ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("0");
    expect(r.fehlendeAngaben).toEqual([]);
  });

  it("18. Geburtstag im Behandlungszeitraum → fehlende Angabe statt stillem „3“", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2008-10-10"), behandlungen, ergaenzung);
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("18. Geburtstag"));
  });

  it("Befreiung mit Zeitraum: deckt alle Termine → ZK 1, beginnt mittendrin → fehlende Angabe", () => {
    const alle = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, befreiungVon: "2026-01-01", befreiungBis: "2026-12-31" });
    expect(alle.fall.zuzahlungskennzeichen).toBe("1");
    expect(alle.fehlendeAngaben).toEqual([]);
    const teil = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, befreiungVon: "2026-10-10", befreiungBis: "2026-12-31" });
    expect(teil.fehlendeAngaben).toContainEqual(expect.stringContaining("Befreiung"));
  });

  it("Befreiung ohne Zeitraum → fehlende Angabe", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, ergaenzung);
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Zeitraum der Zuzahlungsbefreiung"));
  });

  it("volljährig, keine Befreiung, ohne Preis-Snapshot → ZK 3, aber Zuzahlung je Einzelleistung fehlt", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), behandlungen, ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.fehlendeAngaben).toEqual(["Zuzahlung je Einzelleistung aus dem Preis-Snapshot (priceSnapshot.lines[].copayCents)"]);
  });
});

/** Snapshot-Zeilen nach PR #111 (priceSnapshot.lines[].copayCents, flatFeeCents) – erfundene Werte */
const zeilen = (copay: (number | null)[]): PodoHeroBehandlung[] =>
  [
    { date: "2026-10-05", position: "99901", units: 1, priceCents: 3555 },
    { date: "2026-10-05", position: "99902", units: 1, priceCents: 1200 },
    { date: "2026-10-19", position: "99901", units: 1, priceCents: 3555 },
  ].map((z, i) => ({ ...z, copayCents: copay[i] }));

describe("D1–D3 Zuzahlung aus einer Quelle: Preis-Snapshot je Einzelleistung (Nachtrag PR #111)", () => {
  it("D2: Snapshot stimmt mit eigener Rechnung überein → ZK 3, keine Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), zeilen([356, 120, 356]), { ...ergaenzung, pauschaleCents: 1000 });
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.fehlendeAngaben).toEqual([]);
    expect(r.abweichungen).toEqual([]);
  });

  it("D2: abweichender Betrag im Snapshot → Abweichung (Fehler)", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), zeilen([300, 120, 356]), { ...ergaenzung, pauschaleCents: 900 });
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Snapshot 300 Cent, berechnet 356 Cent"));
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Pauschale im Preis-Snapshot 900 Cent, berechnet 1000 Cent"));
  });

  it("D1: copayCents null = Position ohne Zuzahlung (Vergütungsliste „-“/leer) → bei ZK 3 nicht zuzahlungspflichtig", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), zeilen([356, null, 356]), { ...ergaenzung, pauschaleCents: 1000 });
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.fall.leistungen[1].zuzahlungsfaehig).toBe(false);
    expect(r.abweichungen).toEqual([]);
  });

  it("D2: Befreiung ab 10.10. → ZK 4 mit Zuzahlung je Position aus dem Snapshot", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), zeilen([356, 120, 0]), { ...ergaenzung, pauschaleCents: 1000, befreiungVon: "2026-10-10", befreiungBis: "2026-12-31" });
    expect(r.fall.zuzahlungskennzeichen).toBe("4");
    expect(r.fall.leistungen.map((l) => l.zuzahlungspflichtig)).toEqual([true, true, false]);
    expect(r.fall.pauschaleZuzahlung).toBe(true);
    expect(r.abweichungen).toEqual([]);
  });

  it("D2: Kreuz „gebührenfrei“ allein ergibt kein Kennzeichen – Snapshot ohne Zuzahlung, aber nichts belegt → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), zeilen([0, 0, 0]), { ...ergaenzung, pauschaleCents: 0 });
    expect(r.abweichungen).toContainEqual(expect.stringContaining("weder „unter 18“ noch ein Befreiungszeitraum"));
  });

  it("D2: unter 18 und Snapshot ohne Zuzahlung → ZK 0", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2010-03-15"), zeilen([0, 0, 0]), { ...ergaenzung, pauschaleCents: 0 });
    expect(r.fall.zuzahlungskennzeichen).toBe("0");
    expect(r.abweichungen).toEqual([]);
  });

  it("D3: eine Einzelleistung je Datum aus dem Snapshot, doppelte Zeile gleicher Position/Tag → Abweichung", () => {
    const ok = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), zeilen([356, 120, 356]), { ...ergaenzung, pauschaleCents: 1000 });
    expect(ok.fall.leistungen.map((l) => `${l.positionsnummer}@${l.datum}`)).toEqual(["99901@2026-10-05", "99902@2026-10-05", "99901@2026-10-19"]);
    const doppelt = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), [...zeilen([356, 120, 356]), { date: "2026-10-19", position: "99901", units: 1, priceCents: 3555, copayCents: 356 }], ergaenzung);
    expect(doppelt.abweichungen).toContainEqual(expect.stringContaining("zusammenzufassen"));
  });
});
