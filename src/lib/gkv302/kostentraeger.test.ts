import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ausLatin1 } from "./edifact";
import { KostentraegerVerzeichnis, KotrFehler, parseKostentraegerdatei, pruefeKotrDateiname, schreibeKostentraegerdatei } from "./kostentraeger";
import { TEST_IK } from "./fixtures/testdaten";

const roh = ausLatin1(new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "kotr-test.ke0"))));
const datei = parseKostentraegerdatei(roh);
const verzeichnis = new KostentraegerVerzeichnis([datei]);

describe("Kostenträgerdatei – Parser (Anhang 3 V09/V10)", () => {
  it("liest UNA, UNB und alle Nachrichten", () => {
    expect(datei.absenderIk).toBe(TEST_IK.kostentraeger);
    expect(datei.empfaengerIk).toBe("999999999");
    expect(datei.dateinummer).toBe("00001");
    expect(datei.dateiname).toBe("GK05Q426KE0");
    expect(datei.institutionen).toHaveLength(8);
  });

  it("liest Segmente mit Gültigkeit (VDT), Umlaute (ISO 8859-1) und Aufhebungszeichen", () => {
    const kasse = datei.institutionen[0];
    expect(kasse.gueltigkeit).toEqual({ ab: "2026-01-01", bis: "2026-12-31" });
    expect(kasse.anschriften[0].strasseOderPostfach).toBe("Teststraße 2");
    expect(kasse.verknuepfungen[0]).toMatchObject({ art: "01", ik: TEST_IK.kostentraeger, gueltigkeit: { ab: "2026-01-01" } });
    const dav = datei.institutionen[3];
    expect(dav.uebermittlung[0].dfu[0]).toMatchObject({ protokoll: "070", kommunikationskanal: "dav+test@example.org" });
    const kt = datei.institutionen[2];
    expect(kt.verknuepfungen[2]).toMatchObject({ art: "03", abrechnungscode: "99", gueltigkeit: { ab: "2026-01-01", bis: "2026-06-30" } });
    expect(kt.ansprechpartner[0]).toMatchObject({ telefon: "030/0000001", name: "Testperson", arbeitsgebiet: "Datenaustausch" });
    expect(kt.name).toEqual(["Testkasse Zentrale", "Abrechnung"]);
  });

  it("Roundtrip: schreiben und wieder lesen ergibt dasselbe Modell", () => {
    const text = schreibeKostentraegerdatei(datei);
    expect(parseKostentraegerdatei(text)).toEqual(datei);
  });

  it("Dateiname nach Kap. 6", () => {
    expect(pruefeKotrDateiname("AO05Q426.ke2")).toEqual({ kassenart: "AO", gueltigAb: "Q4", jahr: "26", nachtrag: 2 });
    expect(pruefeKotrDateiname("BN050526.ke0")).toEqual({ kassenart: "BN", gueltigAb: "05", jahr: "26", nachtrag: 0 });
    expect(pruefeKotrDateiname("SB05Q127.KE0")?.kassenart).toBe("SB");
    expect(pruefeKotrDateiname("AO01Q426.ke0")).toBeNull();
  });

  it("Strukturfehler werden mit deutscher Meldung abgewiesen", () => {
    expect(() => parseKostentraegerdatei("UNH+1+KOTR:02:001:KV'")).toThrow(KotrFehler);
    const falscheZahl = roh.replace("UNT+000009+00001'", "UNT+000008+00001'");
    expect(() => parseKostentraegerdatei(falscheZahl)).toThrow("UNT nennt 8 Segmente, gezählt wurden 9");
    const ohneVdt = roh.replace("IDK+990040019+99+TEST-BELEGANNAHME'\r\nVDT+20260101'\r\n", "IDK+990040019+99+TEST-BELEGANNAHME'\r\n").replace("UNT+000007+00007'", "UNT+000006+00007'");
    expect(() => parseKostentraegerdatei(ohneVdt)).toThrow("IDK ohne VDT");
    expect(() => parseKostentraegerdatei(roh.replace("UNZ+000008", "UNZ+000009"))).toThrow("UNZ nennt 9 Nachrichten");
    expect(() => parseKostentraegerdatei(roh.slice(0, -3))).toThrow("Segmentendezeichen");
  });
});

describe("Kostenträgerdatei – Annahmestellen ermitteln", () => {
  it("Podologie (71): Kasse → Kostenträger → DAV mit Entschlüsselung → Weiterleitung, E-Mail, Belegannahme", () => {
    const e = verzeichnis.ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2026-11-02", abrechnungscode: "71" });
    expect(e.kostentraeger.ik).toBe(TEST_IK.kostentraeger);
    expect(e.datenannahmestelle).toMatchObject({ ik: TEST_IK.davMitEntschluesselung, name: "Test-Datenannahmestelle" });
    expect(e.physikalischerEmpfaenger.ik).toBe(TEST_IK.davWeiterleitung);
    // KIM-Weg erst ab 2027 gültig
    expect(e.uebertragungswege).toEqual([{ protokoll: "070", kanal: "annahme@example.org" }]);
    expect(e.belegannahmestellen).toEqual([
      { ik: TEST_IK.belegannahme, name: "Test-Belegannahme Podologie", anschriften: [{ art: "1", plz: "10117", ort: "Berlin", strasseOderPostfach: "Belegweg 3" }], artDerDatenlieferung: "28" },
    ]);
    expect(e.hinweise).toEqual([]);
  });

  it("Gültigkeit nach Datum: ab 2027 neue Kassennachricht und zusätzlich KIM-Weg", () => {
    const e = verzeichnis.ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2027-02-01", abrechnungscode: "71" });
    expect(verzeichnis.institution(TEST_IK.kasse, "2027-02-01")?.name).toEqual(["Testkasse Nord (neu)"]);
    expect(e.uebertragungswege).toContainEqual({ protokoll: "080", kanal: "VZD" });
  });

  it("Sonderschlüssel 99 gilt für nicht aufgeführte Codes – nur solange die Verknüpfung gültig ist", () => {
    const vorher = verzeichnis.ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2026-05-01", abrechnungscode: "72" });
    expect(vorher.datenannahmestelle.ik).toBe(TEST_IK.davWeiterleitung);
    expect(() => verzeichnis.ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2026-08-01", abrechnungscode: "72" })).toThrow(
      "keine Datenannahmestelle mit Entschlüsselungsbefugnis für Abrechnungscode 72",
    );
  });

  it("Gruppenschlüssel 20 umfasst 21–29, aber nicht Podologie 71", () => {
    const ergo = verzeichnis.ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2026-11-02", abrechnungscode: "26" });
    expect(ergo.datenannahmestelle.ik).toBe("990030039");
    expect(ergo.belegannahmestellen.map((b) => b.ik)).toEqual(["990040020"]);
  });

  it("unbekannte oder noch nicht gültige Kassen-IK", () => {
    expect(() => verzeichnis.ermittle({ kasseIk: "990099998", stichtag: "2026-11-02", abrechnungscode: "71" })).toThrow("nicht enthalten");
    expect(() => verzeichnis.ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2025-12-31", abrechnungscode: "71" })).toThrow("zum 2025-12-31 nicht enthalten");
  });
});
