import { describe, expect, it } from "vitest";
import { erzeugeAuftragsdatei, leseAuftragssatz, type AuftragsdateiDaten } from "./auftragsdatei";
import { auftragsdateiName, logischerDateiname, physikalischerDateiname, verfahrenskennung } from "./dateiname";
import { erzeugeNutzdatendatei } from "./nutzdatei";
import { TEST_IK, testDatei } from "./fixtures/testdaten";

const basis: AuftragsdateiDaten = {
  dateiart: "test",
  transfernummer: 1,
  absenderEigner: TEST_IK.praxis,
  empfaengerNutzer: TEST_IK.davMitEntschluesselung,
  empfaengerPhysikalisch: TEST_IK.davWeiterleitung,
  dateiname: "SL001001S10",
  erstellt: "2026-11-02 09:30:00",
  groesseNutzdaten: 1234,
  groesseUebertragung: 5678,
  verschluesselt: true,
  emailAbsender: "abrechnung@example.org",
};

describe("Dateinamen (Anhang 1 Kap. 4.2/4.3, Anhang 2 Kap. 5/6)", () => {
  it("logischer Dateiname: SL + IK-Stellen 3–8 + S/A + Monat", () => {
    expect(logischerDateiname("990010013", "S", 3)).toBe("SL001001S03");
    expect(logischerDateiname("990050012", "A", 12)).toBe("SL005001A12");
    expect(() => logischerDateiname("990010013", "S", 13)).toThrow("Abrechnungsmonat");
  });

  it("physikalischer Dateiname: Echt E, Test und Erprobung T", () => {
    expect(physikalischerDateiname("echt", 7)).toBe("ESOL0007");
    expect(physikalischerDateiname("test", 7)).toBe("TSOL0007");
    expect(physikalischerDateiname("erprobung", 999)).toBe("TSOL0999");
    expect(verfahrenskennung("echt")).toBe("ESOL0");
    expect(auftragsdateiName("ESOL0007")).toBe("ESOL0007.AUF");
    expect(() => physikalischerDateiname("echt", 1000)).toThrow();
  });
});

describe("Auftragsdatei (GGT Anlage 2, 348 Byte)", () => {
  it("hat genau 348 Zeichen/Byte und die Felder an den festgelegten Stellen", () => {
    const a = erzeugeAuftragsdatei(basis);
    const s = a.text;
    const f = (von: number, bis: number) => s.slice(von - 1, bis);
    expect(s.length).toBe(348);
    expect(a.bytes.length).toBe(348);
    expect(a.name).toBe("TSOL0001.AUF");
    expect(a.nutzdateiName).toBe("TSOL0001");
    expect(f(1, 6)).toBe("500000");
    expect(f(7, 8)).toBe("01");
    expect(f(9, 16)).toBe("00000348");
    expect(f(17, 19)).toBe("000");
    expect(f(20, 24)).toBe("TSOL0");
    expect(f(25, 27)).toBe("001");
    expect(f(33, 47)).toBe("990010013      ");
    expect(f(63, 77)).toBe("990030017      ");
    expect(f(78, 92)).toBe("990030028      ");
    expect(f(93, 104)).toBe("000000000000");
    expect(f(105, 115)).toBe("SL001001S10");
    expect(f(116, 129)).toBe("20261102093000");
    expect(f(130, 143)).toBe("20261102093000");
    expect(f(144, 171)).toBe("0".repeat(28));
    expect(f(172, 178)).toBe("0000000");
    expect(f(179, 190)).toBe("000000001234");
    expect(f(191, 202)).toBe("000000005678");
    expect(f(203, 204)).toBe("I1");
    expect(f(205, 210)).toBe("000303");
    expect(f(211, 226)).toBe("   0000000000000");
    expect(f(275, 344).trimEnd()).toBe("abrechnung@example.org");
  });

  it("Roundtrip: lesen ergibt die geschriebenen Werte", () => {
    const g = leseAuftragssatz(erzeugeAuftragsdatei({ ...basis, dateiart: "echt", verschluesselt: false }).text);
    expect(g).toMatchObject({
      identifikator: "500000",
      verfahrenKennung: "ESOL0",
      transfernummer: "001",
      absenderEigner: "990010013",
      absenderPhysikalisch: "990010013",
      empfaengerNutzer: "990030017",
      empfaengerPhysikalisch: "990030028",
      dateiname: "SL001001S10",
      groesseNutzdaten: 1234,
      verschluesselungsart: "00",
      elektronischeUnterschrift: "00",
    });
  });

  it("passt zur erzeugten Nutzdatei (Dateiname, Größe)", () => {
    const n = erzeugeNutzdatendatei(testDatei({ zeilenumbruch: false }));
    const a = erzeugeAuftragsdatei({ ...basis, dateiname: n.logischerDateiname, groesseNutzdaten: n.bytes.length });
    expect(leseAuftragssatz(a.text).dateiname).toBe(n.logischerDateiname);
    expect(leseAuftragssatz(a.text).groesseNutzdaten).toBe(n.bytes.length);
  });

  it("Fehler bei zu langen Werten und falschem Zeitformat", () => {
    expect(() => erzeugeAuftragsdatei({ ...basis, emailAbsender: "x".repeat(71) })).toThrow("70 Zeichen");
    expect(() => erzeugeAuftragsdatei({ ...basis, erstellt: "02.11.2026" })).toThrow("JJJJ-MM-TT HH:MM:SS");
    expect(() => erzeugeAuftragsdatei({ ...basis, dateiname: "SL001" })).toThrow("11 Stellen");
    expect(() => leseAuftragssatz("zu kurz")).toThrow("348");
  });
});
