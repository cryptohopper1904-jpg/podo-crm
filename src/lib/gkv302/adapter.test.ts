import { describe, expect, it } from "vitest";
import { bildeAbrechnungsfall, type PodoHeroBehandlung, type PodoHeroPatient, type PodoHeroVerordnung, type PreisSnapshot, type PreisSnapshotZeile } from "./adapter";
import { fallBetraege } from "./betraege";

const vo: PodoHeroVerordnung = { id: "v1", issuedAt: "2026-10-01", diagnosisGroup: "DF", icd10: "E11.74", homeVisit: false, urgent: false, copaymentExempt: false, therapyReportRequested: false, source: "paper" };
const patient = (birthDate: string): PodoHeroPatient => ({ lastName: "Test", firstName: "Toni", birthDate, insuranceNumber: "X000000003", insuranceStatus: "1000000", insurerIk: "990020015" });
const behandlungen: PodoHeroBehandlung[] = [
  { date: "2026-10-05", position: "99901", units: 1, priceCents: 3555 },
  { date: "2026-10-19", position: "99901", units: 1, priceCents: 3555 },
];
const ergaenzung = { verordnungsart: "03" as const, leitsymptomatik: { art: "heilmittelrichtlinie" as const, a: true, b: false, c: false, patientenindividuell: false } };

describe("B4 Zuzahlungskennzeichen im Adapter ohne Preis-Snapshot (Anlage 3 8.1.3; § 32 Abs. 2 SGB V)", () => {
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
    const alle = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, befreiungen: [{ von: "2026-01-01", bis: "2026-12-31" }] });
    expect(alle.fall.zuzahlungskennzeichen).toBe("1");
    expect(alle.fehlendeAngaben).toEqual([]);
    const teil = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, befreiungen: [{ von: "2026-10-10", bis: "2026-12-31" }] });
    expect(teil.fehlendeAngaben).toContainEqual(expect.stringContaining("Befreiung"));
  });

  it("Befreiung ohne Zeitraum → fehlende Angabe", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, ergaenzung);
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Zeitraum der Zuzahlungsbefreiung"));
  });

  it("volljährig, keine Befreiung, ohne Preis-Snapshot → ZK 3, aber Zuzahlung je Einzelleistung fehlt", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), behandlungen, ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.fehlendeAngaben).toEqual(["Preis-Snapshot der Verordnung (priceSnapshot: Zuzahlung je Einzelleistung und Pauschale)"]);
  });
});

describe("S3 mehrere Befreiungszeiträume", () => {
  it("zwei lückenlose Zeiträume (Kalenderjahre) decken alle Termine → ZK 1", () => {
    const termine: PodoHeroBehandlung[] = [
      { date: "2026-12-20", position: "99901", units: 1, priceCents: 3555 },
      { date: "2027-01-10", position: "99901", units: 1, priceCents: 3555 },
    ];
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), termine, {
      ...ergaenzung,
      befreiungen: [
        { von: "2026-01-01", bis: "2026-12-31" },
        { von: "2027-01-01", bis: "2027-12-31" },
      ],
    });
    expect(r.fall.zuzahlungskennzeichen).toBe("1");
    expect(r.fehlendeAngaben).toEqual([]);
  });

  it("Zeitraum mit vertauschten Grenzen → fehlende Angabe", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, befreiungen: [{ von: "2026-12-31", bis: "2026-01-01" }] });
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Befreiungszeitraum"));
  });
});

// ───────────── Preis-Snapshot nach PR #111 (priceSnapshot), nachgebaut ─────────────

/** Zeile wie `priceSnapshot.lines[]` aus PR #111 (Positionsnummer ZL, units 1 je Termin) */
const zeile = (date: string, position: string, priceCents: number | null, copayCents: number | null, extra: Partial<PreisSnapshotZeile> = {}): PreisSnapshotZeile => ({
  date,
  position,
  units: 1,
  priceCents,
  copayCents,
  minor: false,
  exempt: false,
  ...extra,
});
const snapshot = (lines: PreisSnapshotZeile[], flatFeeCents = 1000, complete = true): PreisSnapshot => ({ lines, flatFeeCents, complete });

/** Echte Positionen der Vergütungsliste Podologie (Anlage 2, Preise ab 01.07.2025): 78020 50,55 € / 5,06 €, 78530 16,86 € / ohne, 78220 54,24 € / ohne */
const P78020 = (date: string, copay: number | null = 506, extra: Partial<PreisSnapshotZeile> = {}) => zeile(date, "78020", 5055, copay, extra);
const P78530 = (date: string, extra: Partial<PreisSnapshotZeile> = {}) => zeile(date, "78530", 1686, null, extra);
const P78220 = (date: string) => zeile(date, "78220", 5424, null);

describe("R2-1 Snapshot-Vertrag mit PR #111: copayCents number | null", () => {
  it("[506, null, 506] mit 78530 → ZK 3 ohne Abweichung; 78530 nicht zuzahlungsfähig", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78530("2026-10-05"), P78020("2026-10-19")]), ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.fehlendeAngaben).toEqual([]);
    expect(r.abweichungen).toEqual([]);
    expect(r.fall.leistungen.map((l) => l.zuzahlungsfaehig)).toEqual([undefined, false, undefined]);
    const b = fallBetraege(r.fall, 10, 1000);
    expect(b.prozentualeZuzahlungCent).toBe(1012);
    expect(b.pauschaleZuzahlungCent).toBe(1000);
  });

  it("[506, null] mit 78220 → ZK 3 ohne Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78220("2026-10-05")]), ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.abweichungen).toEqual([]);
    expect(r.fall.leistungen[1].zuzahlungsfaehig).toBe(false);
  });

  it("copayCents 0 bei einer Position mit Zuzahlung für Volljährige ohne Befreiung → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78020("2026-10-19", 0)]), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("2026-10-19"));
  });

  it("minor/exempt je Zeile werden gegen Alter/Befreiung geprüft", () => {
    // Zeile als „unter 18“ markiert, Person aber volljährig
    const minor = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05", 0, { minor: true }), P78020("2026-10-19", 0, { minor: true })], 0), ergaenzung);
    expect(minor.abweichungen).toContainEqual(expect.stringContaining("als „unter 18“ gekennzeichnet"));
    // Zeile als befreit markiert, aber mit Zuzahlung
    const widerspruch = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05", 506, { exempt: true })]), ergaenzung);
    expect(widerspruch.abweichungen).toContainEqual(expect.stringContaining("trotzdem Zuzahlung"));
    // Befreiung belegt, Zeile aber nicht als befreit gekennzeichnet
    const nichtMarkiert = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05", 0)], 0), { ...ergaenzung, befreiungen: [{ von: "2026-01-01", bis: "2026-12-31" }] });
    expect(nichtMarkiert.abweichungen).toContainEqual(expect.stringContaining("nicht als befreit gekennzeichnet"));
    // stimmig: befreit belegt und markiert → ZK 1
    const ok = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05", 0, { exempt: true }), P78530("2026-10-05", { exempt: true })], 0), { ...ergaenzung, befreiungen: [{ von: "2026-01-01", bis: "2026-12-31" }] });
    expect(ok.fall.zuzahlungskennzeichen).toBe("1");
    expect(ok.abweichungen).toEqual([]);
  });

  it("D2: abweichender Betrag im Snapshot → Abweichung (Fehler)", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05", 500), P78020("2026-10-19")]), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Snapshot 500 Cent, berechnet 506 Cent"));
  });

  it("D2: Befreiung ab 10.10. → ZK 4 mit Zuzahlung je Position aus dem Snapshot", () => {
    const r = bildeAbrechnungsfall(
      "1",
      { ...vo, copaymentExempt: true },
      patient("1960-01-01"),
      snapshot([P78020("2026-10-05"), P78530("2026-10-05"), P78020("2026-10-19", 0, { exempt: true })]),
      { ...ergaenzung, befreiungen: [{ von: "2026-10-10", bis: "2026-12-31" }] },
    );
    expect(r.fall.zuzahlungskennzeichen).toBe("4");
    expect(r.fall.leistungen.map((l) => l.zuzahlungspflichtig)).toEqual([true, false, false]);
    expect(r.fall.pauschaleZuzahlung).toBe(true);
    expect(r.abweichungen).toEqual([]);
  });

  it("D2: unter 18 und Snapshot ohne Zuzahlung → ZK 0", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2010-03-15"), snapshot([P78020("2026-10-05", 0, { minor: true }), P78530("2026-10-05", { minor: true })], 0), ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("0");
    expect(r.abweichungen).toEqual([]);
  });

  it("D3: eine Einzelleistung je Datum aus dem Snapshot, doppelte Zeile gleicher Position/Tag → Abweichung", () => {
    const ok = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78530("2026-10-05"), P78020("2026-10-19")]), ergaenzung);
    expect(ok.fall.leistungen.map((l) => `${l.positionsnummer}@${l.datum}`)).toEqual(["78020@2026-10-05", "78530@2026-10-05", "78020@2026-10-19"]);
    const doppelt = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78020("2026-10-05")]), ergaenzung);
    expect(doppelt.abweichungen).toContainEqual(expect.stringContaining("zusammenzufassen"));
  });
});

describe("S1 Preis fehlt bzw. Snapshot unvollständig → fehlende Angabe", () => {
  it("priceCents null", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), zeile("2026-10-19", "78020", null, 0)], 1000, false), ergaenzung);
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Preis je Einheit für Position 78020 am 2026-10-19"));
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Snapshot unvollständig"));
  });

  it("complete = false allein", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05")], 1000, false), ergaenzung);
    expect(r.fehlendeAngaben).toEqual([expect.stringContaining("Snapshot unvollständig")]);
  });

  it("ohne Snapshot: Preis null → fehlende Angabe", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2010-03-15"), [{ date: "2026-10-05", position: "78020", units: 1, priceCents: null }], ergaenzung);
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Preis je Einheit"));
  });
});

describe("S2 Positionsnummer: Snapshot liefert ZL, Umschlüsselung KH/KB über Callback", () => {
  it("ohne Callback bleibt die ZL-Nummer", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05")]), ergaenzung);
    expect(r.fall.leistungen[0].positionsnummer).toBe("78020");
  });

  it("mit Callback (z. B. hpnrFor aus PR #111 für eine KH-Praxis) → 68020", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78530("2026-10-05")]), { ...ergaenzung, positionsnummer: (zl) => `6${zl.slice(1)}` });
    expect(r.fall.leistungen.map((l) => l.positionsnummer)).toEqual(["68020", "68530"]);
    expect(r.abweichungen).toEqual([]);
  });

  it("Callback liefert keine 5-stellige Nummer → fehlende Angabe", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05")]), { ...ergaenzung, positionsnummer: () => "" });
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Positionsnummer für 78020"));
  });
});

describe("R2-4 vorgegebenes Kennzeichen mit Verarbeitungskennzeichen", () => {
  it("ZK 2 bei VKZ 03: Gegenrechnung mit VKZ 03, Angaben je Position aus dem Snapshot", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78530("2026-10-05"), P78020("2026-10-19")]), { ...ergaenzung, zuzahlungskennzeichen: "2", verarbeitungskennzeichen: "03" });
    expect(r.fall.zuzahlungskennzeichen).toBe("2");
    expect(r.abweichungen).toEqual([]);
    expect(fallBetraege(r.fall, 10, 1000, "03").gesetzlicheZuzahlungCent).toBe(2012);
  });

  it("ZK 5 bei VKZ 03: nur die Termine mit Zuzahlung, Pauschale laut Snapshot", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-12-20", 0), P78020("2027-01-10")], 0), { ...ergaenzung, zuzahlungskennzeichen: "5", verarbeitungskennzeichen: "03" });
    expect(r.fall.leistungen.map((l) => l.zuzahlungspflichtig)).toEqual([false, true]);
    expect(r.fall.pauschaleZuzahlung).toBe(false);
    expect(r.abweichungen).toEqual([]);
  });

  it("F4: vorgegebenes Kennzeichen ohne VKZ → Standard-VKZ „01“, Angaben je Position aus dem Snapshot, stimmig → keine Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05")]), { ...ergaenzung, zuzahlungskennzeichen: "2" });
    expect(r.abweichungen).toEqual([]);
    expect(r.fall.leistungen[0].zuzahlungspflichtig).toBe(true);
    expect(r.fall.pauschaleZuzahlung).toBe(true);
  });

  it("F4: ZK „1“ vorgegeben ohne VKZ, Snapshot mit Zuzahlung (2 × 78020 = 10,12 € + 10,00 €) → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1950-03-15"), snapshot([P78020("2026-07-06"), P78020("2026-08-03")]), { ...ergaenzung, zuzahlungskennzeichen: "1" });
    expect(r.fall.zuzahlungskennzeichen).toBe("1");
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Snapshot 506 Cent, berechnet 0 Cent"));
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Pauschale im Preis-Snapshot 1000 Cent, berechnet 0 Cent"));
  });

  it("abweichender Betrag wird auch bei vorgegebenem Kennzeichen mit VKZ erkannt", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05", 400)]), { ...ergaenzung, zuzahlungskennzeichen: "2", verarbeitungskennzeichen: "03" });
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Snapshot 400 Cent, berechnet 506 Cent"));
  });
});

describe("R2-5 Kreuz „gebührenfrei“ gegen Snapshot", () => {
  it("Kreuz gesetzt, Snapshot mit Zuzahlung → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78020("2026-10-19")]), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("gebührenfrei"));
  });

  it("Kreuz gesetzt, Befreiungszeitraum deckt keinen Termin → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05")]), { ...ergaenzung, befreiungen: [{ von: "2025-01-01", bis: "2025-12-31" }] });
    expect(r.abweichungen).toContainEqual(expect.stringContaining("gebührenfrei"));
  });

  it("Kreuz allein, Snapshot ohne Zuzahlung, aber nichts belegt → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05", 0)], 0), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("weder „unter 18“ noch ein Befreiungszeitraum"));
  });
});

describe("R2-6 Pauschale gegen Alter/Befreiung am ersten Behandlungstag", () => {
  it("unter 18 + Pauschale 1000 → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2010-03-15"), snapshot([P78020("2026-10-05", 0, { minor: true })], 1000), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Pauschale"));
  });

  it("unter 18 nur mit zuzahlungsfreien Positionen + Pauschale 1000 → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2010-03-15"), snapshot([P78530("2026-10-05", { minor: true })], 1000), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Pauschale"));
  });

  it("volljährig ohne Pauschale → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05")], 0), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Pauschale"));
  });
});

describe("R2-7/R2-8 Pauschale aus dem Snapshot, Höhe wie in der Nutzdatei", () => {
  it("Snapshot ohne gültige flatFeeCents → fehlende Angabe", () => {
    const s = { lines: [P78020("2026-10-05")], complete: true } as unknown as PreisSnapshot;
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), s, ergaenzung);
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("flatFeeCents"));
  });

  it("abweichende Pauschalenhöhe (zuzahlungPauschaleCent) wird in der Gegenrechnung verwendet", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([P78020("2026-10-05")], 1000), { ...ergaenzung, zuzahlungPauschaleCent: 1200 });
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Pauschale im Preis-Snapshot 1000 Cent, berechnet 1200 Cent"));
  });
});

// ───────────── Review-Runde 3 (Gegenbeispiele der Reviewer) ─────────────

describe("V1 Geburtsdatum mit unbekanntem Tag + Zeile „unter 18“", () => {
  it("Geburt 2008-11-00, Termin 2026-11-03 als minor ohne Zuzahlung, Pauschale 0 → ZK 0 statt 1, keine Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2008-11-00"), snapshot([P78020("2026-11-03", 0, { minor: true })], 0), ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("0");
    expect(r.abweichungen).toEqual([]);
    expect(r.fehlendeAngaben).toEqual([]);
  });
});

describe("V2 minderjährig und zugleich befreit (#111 setzt minor und exempt)", () => {
  it("Geburt 2012-01-01, Befreiung 2026, Zeile minor+exempt ohne Zuzahlung → ZK 0 ohne Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("2012-01-01"), snapshot([P78020("2026-10-05", 0, { minor: true, exempt: true })], 0), {
      ...ergaenzung,
      befreiungen: [{ von: "2026-01-01", bis: "2026-12-31" }],
    });
    expect(r.fall.zuzahlungskennzeichen).toBe("0");
    expect(r.abweichungen).toEqual([]);
  });

  it("minderjährig, Zeile als befreit markiert, aber kein Befreiungszeitraum → Abweichung bleibt", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2012-01-01"), snapshot([P78020("2026-10-05", 0, { minor: true, exempt: true })], 0), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("kein Befreiungszeitraum enthält den Termin"));
  });

  it("minderjährig, Befreiungszeitraum deckt den Termin, Zeile aber nicht als befreit → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2012-01-01"), snapshot([P78020("2026-10-05", 0, { minor: true })], 0), { ...ergaenzung, befreiungen: [{ von: "2026-01-01", bis: "2026-12-31" }] });
    expect(r.abweichungen).toContainEqual(expect.stringContaining("nicht als befreit gekennzeichnet"));
  });
});

describe("V3 Kreuz „gebührenfrei“ bei Kind, 18. Geburtstag im Behandlungszeitraum", () => {
  it("erster Termin minderjährig frei, zweiter mit Zuzahlung → ZK 5, [false, true], ohne Pauschale, keine Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("2008-10-10"), snapshot([P78020("2026-10-05", 0, { minor: true }), P78020("2026-10-19")], 0), ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("5");
    expect(r.fall.leistungen.map((l) => l.zuzahlungspflichtig)).toEqual([false, true]);
    expect(r.fall.pauschaleZuzahlung).toBe(false);
    expect(r.abweichungen).toEqual([]);
    expect(r.fehlendeAngaben).toEqual([]);
  });
});

describe("F3 gedeckelte Pauschale (#111: flatFeeCents = min(1000, Heilmittelkosten − prozentuale Zuzahlung))", () => {
  it("78030 allein (Brutto 357, 10 % = 36) mit Pauschale 321 → keine Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([zeile("2026-10-05", "78030", 357, 36)], 321), ergaenzung);
    expect(r.abweichungen).toEqual([]);
    expect(fallBetraege(r.fall, 10, 1000).pauschaleZuzahlungCent).toBe(321);
  });

  it("Position 900 / 90 mit Pauschale 810 → keine Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([zeile("2026-10-05", "78999", 900, 90)], 810), ergaenzung);
    expect(r.abweichungen).toEqual([]);
  });

  it("ungedeckelte Pauschale 1000 bei Brutto 357 → Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), snapshot([zeile("2026-10-05", "78030", 357, 36)], 1000), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("Pauschale im Preis-Snapshot 1000 Cent, berechnet 321 Cent"));
  });
});

describe("S4 Kreuz „gebührenfrei“ ohne Befreiungsbescheinigung, bestätigt", () => {
  it("ohne Bestätigung → Abweichung (wie bisher)", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78020("2026-10-19")]), ergaenzung);
    expect(r.abweichungen).toContainEqual(expect.stringContaining("gebührenfrei"));
    expect(r.hinweise).toEqual([]);
  });

  it("mit kreuzOhneBescheinigungBestaetigt → ZK 3, Zuzahlung übernommen, Hinweis statt Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05"), P78020("2026-10-19")]), { ...ergaenzung, kreuzOhneBescheinigungBestaetigt: true });
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.abweichungen).toEqual([]);
    expect(r.fehlendeAngaben).toEqual([]);
    expect(r.hinweise).toContainEqual(expect.stringContaining("ohne Befreiungsbescheinigung"));
  });

  it("ohne Snapshot mit Bestätigung → zuzahlungspflichtig (Snapshot fehlt), kein „Zeitraum der Befreiung“ mehr verlangt", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, kreuzOhneBescheinigungBestaetigt: true });
    expect(r.fall.zuzahlungskennzeichen).toBe("3");
    expect(r.fehlendeAngaben).toEqual(["Preis-Snapshot der Verordnung (priceSnapshot: Zuzahlung je Einzelleistung und Pauschale)"]);
    expect(r.hinweise).toContainEqual(expect.stringContaining("ohne Befreiungsbescheinigung"));
  });
});

describe("S5 Hinweise: Snapshot-notes und Befreiung einer anderen Kasse", () => {
  it("notes des Snapshots werden als hinweise durchgereicht", () => {
    const s = { ...snapshot([P78020("2026-10-05")]), notes: ["Geburtsdatum fehlt – bitte prüfen."] };
    const r = bildeAbrechnungsfall("1", vo, patient("1960-01-01"), s, ergaenzung);
    expect(r.hinweise).toEqual(["Geburtsdatum fehlt – bitte prüfen."]);
    expect(r.abweichungen).toEqual([]);
  });

  it("Befreiungszeitraum mit anderem insurerIk als die Verordnung → Hinweis, keine Sperre", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05", 0, { exempt: true })], 0), {
      ...ergaenzung,
      befreiungen: [{ von: "2026-01-01", bis: "2026-12-31", insurerIk: "990000006" }],
    });
    expect(r.fall.zuzahlungskennzeichen).toBe("1");
    expect(r.abweichungen).toEqual([]);
    expect(r.fehlendeAngaben).toEqual([]);
    expect(r.hinweise).toContainEqual(expect.stringContaining("IK 990000006"));
  });

  it("gleiches insurerIk → kein Hinweis", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78020("2026-10-05", 0, { exempt: true })], 0), {
      ...ergaenzung,
      befreiungen: [{ von: "2026-01-01", bis: "2026-12-31", insurerIk: "990020015" }],
    });
    expect(r.hinweise).toEqual([]);
  });
});

describe("S6 Befreiungen als {von, bis} oder {validFrom, validTo} (#111 CopaymentExemption)", () => {
  it("validFrom/validTo wird wie von/bis behandelt", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, befreiungen: [{ validFrom: "2026-01-01", validTo: "2026-12-31" }] });
    expect(r.fall.zuzahlungskennzeichen).toBe("1");
    expect(r.fehlendeAngaben).toEqual([]);
  });

  it("gemischte Formen über den Jahreswechsel → ZK 1", () => {
    const termine: PodoHeroBehandlung[] = [
      { date: "2026-12-20", position: "99901", units: 1, priceCents: 3555 },
      { date: "2027-01-10", position: "99901", units: 1, priceCents: 3555 },
    ];
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), termine, {
      ...ergaenzung,
      befreiungen: [
        { von: "2026-01-01", bis: "2026-12-31" },
        { validFrom: "2027-01-01", validTo: "2027-12-31" },
      ],
    });
    expect(r.fall.zuzahlungskennzeichen).toBe("1");
  });

  it("validFrom/validTo vertauscht → fehlende Angabe", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), behandlungen, { ...ergaenzung, befreiungen: [{ validFrom: "2026-12-31", validTo: "2026-01-01" }] });
    expect(r.fehlendeAngaben).toContainEqual(expect.stringContaining("Befreiungszeitraum"));
  });
});

describe("Hinweis 2: nur zuzahlungsfreie Positionen mit 18. Geburtstag im Behandlungszeitraum", () => {
  it("2 × 78530, erster Termin minderjährig, zweiter volljährig, Pauschale 0 → ZK 5 ohne Zuzahlung, keine Abweichung", () => {
    const r = bildeAbrechnungsfall("1", vo, patient("2008-10-10"), snapshot([P78530("2026-10-05", { minor: true }), P78530("2026-10-19")], 0), ergaenzung);
    expect(r.fall.zuzahlungskennzeichen).toBe("5");
    expect(r.fall.leistungen.map((l) => l.zuzahlungspflichtig)).toEqual([false, false]);
    expect(r.fall.pauschaleZuzahlung).toBe(false);
    expect(r.abweichungen).toEqual([]);
    expect(fallBetraege(r.fall, 10, 1000).gesetzlicheZuzahlungCent).toBe(0);
  });

  it("nur zuzahlungsfreie Positionen, mehrfacher Wechsel (Befreiungslücke) → verständliche Abweichung", () => {
    const r = bildeAbrechnungsfall("1", { ...vo, copaymentExempt: true }, patient("1960-01-01"), snapshot([P78530("2026-10-05", { exempt: true }), P78530("2026-10-19"), P78530("2026-11-02", { exempt: true })], 0), {
      ...ergaenzung,
      befreiungen: [
        { von: "2026-10-01", bis: "2026-10-10" },
        { von: "2026-11-01", bis: "2026-12-31" },
      ],
    });
    expect(r.abweichungen).toContainEqual(expect.stringContaining("nur Positionen ohne Zuzahlung"));
  });
});
