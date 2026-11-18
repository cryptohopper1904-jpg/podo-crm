import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ausLatin1 } from "./edifact";
import { KOTR_GRENZEN, KOTR_MAX_BYTES, KostentraegerVerzeichnis, KotrFehler, parseKostentraegerdatei, pruefeKotrDateiname, pruefeKotrUmfang, schreibeKostentraegerdatei } from "./kostentraeger";
import { ausLatin1 as ausLatin1Neu, vorpruefeEdifact, zerlegeEdifact } from "./edifact";
import type { KotrInstitution } from "./kostentraeger";
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

describe("C4 NAM gefolgt von VDT (Anhang 3 V10 Kap. 7, S. 12)", () => {
  it("VDT nach NAM wird als Gültigkeit des Namens gelesen und wieder geschrieben", () => {
    const mitNamVdt = roh
      .replace("NAM+01+Testkasse Zentrale+Abrechnung'\r\n", "NAM+01+Testkasse Zentrale+Abrechnung'\r\nVDT+20260101+20271231'\r\n")
      .replace("UNT+000014+00003'", "UNT+000015+00003'");
    const d = parseKostentraegerdatei(mitNamVdt);
    expect(d.institutionen[2].name).toEqual(["Testkasse Zentrale", "Abrechnung"]);
    expect(d.institutionen[2].nameGueltigkeit).toEqual({ ab: "2026-01-01", bis: "2027-12-31" });
    expect(parseKostentraegerdatei(schreibeKostentraegerdatei(d))).toEqual(d);
  });
});

describe("Sollte: Verknüpfung 02/03 nur mit Art der Datenlieferung 07/30 (Anhang 3 V10 Kap. 5.2, S. 9)", () => {
  it("VKG 03 ohne Art der Datenlieferung zählt nicht", () => {
    const ohne = parseKostentraegerdatei(roh.replace("VKG+03+990030017+5++07+1+++71'", "VKG+03+990030017+5+++1+++71'"));
    expect(() => new KostentraegerVerzeichnis([ohne]).ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2026-11-02", abrechnungscode: "71" })).toThrow("keine Datenannahmestelle mit Entschlüsselungsbefugnis");
  });

  it("mehrere gleichwertige Datenannahmestellen → Hinweis", () => {
    const zwei = parseKostentraegerdatei(
      roh.replace("VKG+03+990030017+5++07+1+++71'\r\n", "VKG+03+990030017+5++07+1+++71'\r\nVKG+03+990030039+5++07+1+++71'\r\n").replace("UNT+000014+00003'", "UNT+000015+00003'"),
    );
    const e = new KostentraegerVerzeichnis([zwei]).ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2026-11-02", abrechnungscode: "71" });
    expect(e.hinweise).toContainEqual(expect.stringContaining("mehrere Datenannahmestellen mit Entschlüsselungsbefugnis"));
  });
});

describe("Kostenträgerdatei – Grenzen gegen Speicher-DoS (Review-Runde 2, AppSec H1/H2)", () => {
  const MB = 1024 * 1024;
  it("bricht vor dem Zerlegen ab: nur Segmentende-Zeichen bzw. nur Elementtrenner", () => {
    // ohne UNA/UNB am Anfang: sofort abgelehnt
    expect(() => parseKostentraegerdatei("'".repeat(MB))).toThrow(/beginnt nicht mit UNA oder UNB/);
    // mit UNB, aber 1 Mio. Segmente
    expect(() => parseKostentraegerdatei("UNB+" + "'".repeat(MB))).toThrow(/zu viele Segmente/);
    // ein Segment mit 1 Mio. Datenelementen
    expect(() => parseKostentraegerdatei("UNB+" + "+".repeat(MB) + "'")).toThrow(/zu viele Datenelemente/);
    expect(() => parseKostentraegerdatei("UNB+" + ":".repeat(MB) + "'")).toThrow(/zu viele Gruppendatenelemente/);
    // zu langes Segment
    expect(() => parseKostentraegerdatei("UNB+" + "A".repeat(MB) + "'")).toThrow(/Segment zu lang/);
  });

  it("Vorprüfung zählt aufgehobene Trennzeichen nicht und beachtet UNA", () => {
    const g = { maxZeichen: 1000, maxSegmente: 3, maxElemente: 3, maxGruppen: 3, maxSegmentLaenge: 100, maxDatenelementeGesamt: 100 };
    expect(() => vorpruefeEdifact("UNB+a?'b?+c'UNZ+1'", g)).not.toThrow();
    expect(() => vorpruefeEdifact("UNA:+.? 'UNB+a'UNH+b'UNT+c'UNZ+1'", g)).toThrow(/zu viele Segmente/);
    expect(() => vorpruefeEdifact("UNA:*.? !UNB*a*b!UNZ*1!", g)).not.toThrow();
    expect(() => vorpruefeEdifact("UNA:*.? !UNB*a*b*c*d!", g)).toThrow(/zu viele Datenelemente/);
    expect(() => vorpruefeEdifact("\ufeffUNB+a'", g)).not.toThrow();
  });

  it("echte Datei liegt weit unter den Grenzen", () => {
    expect(() => vorpruefeEdifact(roh, KOTR_GRENZEN)).not.toThrow();
    expect(() => pruefeKotrUmfang(datei)).not.toThrow();
  });

  it("inhaltliche Grenzen: Institutionen gesamt, Verknüpfungen und Anschriften je Institution", () => {
    expect(() => pruefeKotrUmfang(datei, { maxInstitutionen: 7, maxVerknuepfungen: 100, maxAnschriften: 100, maxGesamt: 1000 })).toThrow(/zu viele Institutionen/);
    expect(() => pruefeKotrUmfang(datei, { maxInstitutionen: 100, maxVerknuepfungen: 3, maxAnschriften: 100, maxGesamt: 1000 })).toThrow(/zu viele Verknüpfungen/);
    const mitAns = structuredClone(datei);
    mitAns.institutionen[0].anschriften = Array.from({ length: 3 }, () => ({ art: "1", plz: "10115", ort: "Berlin" }));
    expect(() => pruefeKotrUmfang(mitAns, { maxInstitutionen: 100, maxVerknuepfungen: 100, maxAnschriften: 2, maxGesamt: 1000 })).toThrow(/zu viele Anschriften/);
  });

  it("viele gleichrangige Verknüpfungen sprengen nicht den Aufrufstapel (reduce statt Math.max(...))", () => {
    const viel = structuredClone(datei);
    const kt = viel.institutionen.find((i) => i.ik === TEST_IK.kostentraeger)!;
    const vkg = kt.verknuepfungen.find((v) => v.art === "03" && v.ik === TEST_IK.davMitEntschluesselung)!;
    kt.verknuepfungen = Array.from({ length: 300_000 }, () => vkg);
    const e = new KostentraegerVerzeichnis([viel]).ermittle({ kasseIk: TEST_IK.kasse, stichtag: "2026-11-18", abrechnungscode: "71" });
    expect(e.datenannahmestelle.ik).toBe(TEST_IK.davMitEntschluesselung);
  });
});

describe("Kostenträgerdatei – Speicherschutz Review-Runde 3", () => {
  it("ausLatin1 entspricht Byte für Byte ISO 8859-1 (alle 256 Werte)", () => {
    const alle = new Uint8Array(256).map((_, i) => i);
    const text = ausLatin1Neu(alle);
    expect(text.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(text.charCodeAt(i)).toBe(i);
    // Teilansicht eines größeren Puffers (byteOffset)
    expect(ausLatin1Neu(alle.subarray(65, 68))).toBe("ABC");
  });

  it("Grenzen an echten Dateien ausgerichtet (größte gemessene: 214 KB, 6 471 Segmente, 12 Elemente/Segment, 116 Zeichen/Segment)", () => {
    expect(KOTR_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(KOTR_GRENZEN).toEqual({ maxZeichen: 2 * 1024 * 1024, maxSegmente: 80_000, maxElemente: 40, maxGruppen: 10, maxSegmentLaenge: 1_000, maxDatenelementeGesamt: 300_000 });
    expect(() => parseKostentraegerdatei("UNB+" + "A".repeat(KOTR_MAX_BYTES))).toThrow(/zu groß/);
  });

  it("synthetische Datei mit den gemessenen Höchstwerten echter Dateien wird angenommen", () => {
    const inst = (n: number, vkg: number): KotrInstitution => ({
      ik: String(990000000 + n), artDerInstitution: "99", kurzbezeichnung: `KASSE ${n}`, gueltigkeit: { ab: "2026-01-01" }, verarbeitungskennzeichen: "01",
      verknuepfungen: Array.from({ length: vkg }, (_, k) => ({ art: "03", ik: "990030017", leistungserbringergruppe: "5", abrechnungsstelleIk: "990050012", artDerDatenlieferung: "07", uebermittlungsmedium: "1", bundesland: String(k % 16).padStart(2, "0"), kvBezirk: "72", abrechnungscode: "71", tarifkennzeichen: "50000", unterverfahren: "1" })),
      name: [`Testkasse ${n}`], anschriften: [{ art: "1", plz: "10115", ort: "Berlin", strasseOderPostfach: "S".repeat(90) }], ansprechpartner: [], uebermittlung: [],
    });
    const institutionen = Array.from({ length: 365 }, (_, n) => inst(n, n === 0 ? 229 : 15));
    const text = schreibeKostentraegerdatei({ absenderIk: "990020026", empfaengerIk: "999999999", erstellt: "261001:1200", dateinummer: "00001", dateiname: "BN050526KE0", institutionen });
    const seg = zerlegeEdifact(text);
    expect(seg.length).toBeGreaterThan(6_471);
    expect(Math.max(...seg.slice(0, 50).map((x) => x.elemente.length + 1))).toBe(12);
    const d = parseKostentraegerdatei(text);
    expect(d.institutionen).toHaveLength(365);
    expect(() => pruefeKotrUmfang(d)).not.toThrow();
    // Fixture weiter angenommen
    expect(() => parseKostentraegerdatei(roh)).not.toThrow();
  });

  it("Gesamtgrenzen nach dem Zerlegen: Verknüpfungen, Ansprechpartner, Übermittlungen, DFÜ", () => {
    const g = { maxInstitutionen: 100, maxVerknuepfungen: 100, maxAnschriften: 100, maxGesamt: 5 };
    expect(() => pruefeKotrUmfang(datei, g)).toThrow(/zu viele Verknüpfungen insgesamt/);
    const ohneVkg = structuredClone(datei);
    for (const i of ohneVkg.institutionen) i.verknuepfungen = [];
    ohneVkg.institutionen[0].ansprechpartner = Array.from({ length: 6 }, (_, k) => ({ lfdNr: String(k) }));
    expect(() => pruefeKotrUmfang(ohneVkg, g)).toThrow(/zu viele Ansprechpartner insgesamt/);
    ohneVkg.institutionen[0].ansprechpartner = [];
    ohneVkg.institutionen[0].uebermittlung = [{ medium: "1", parameter: "00", zeichensatz: "I8", dfu: Array.from({ length: 6 }, (_, k) => ({ lfdNr: String(k), protokoll: "070", kommunikationskanal: "x@example.org" })) }];
    expect(() => pruefeKotrUmfang(ohneVkg, g)).toThrow(/zu viele DFÜ-Angaben insgesamt/);
    ohneVkg.institutionen[0].uebermittlung = Array.from({ length: 6 }, () => ({ medium: "1", parameter: "00", zeichensatz: "I8", dfu: [] }));
    expect(() => pruefeKotrUmfang(ohneVkg, g)).toThrow(/zu viele Übermittlungsangaben insgesamt/);
  });

  it("schlimmste noch zulässige Eingabe: Zerlegen braucht < 100 MB Heap und < 1 s", () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    const G = KOTR_GRENZEN;
    // alle Grenzen gleichzeitig ausgereizt: Segmente knapp unter 1 000 Zeichen mit 36 Elementen à 8 Gruppen aus je zwei
    // Zeichen (zweistellige Felder kosten mehr als einstellige), bis zur Gesamtgrenze der Felder; Rest kleine Segmente
    const segment = ("AB" + ":AB".repeat(7) + "+").repeat(36) + "AB'";
    const n = Math.floor((G.maxDatenelementeGesamt - 1000) / 289);
    let text = "UNB+UNOC'" + segment.repeat(n);
    text += "AB'".repeat(Math.min(G.maxSegmente - 2 - n, Math.floor((G.maxZeichen - text.length) / 3)));
    expect(text.length).toBeLessThanOrEqual(G.maxZeichen);
    expect(() => vorpruefeEdifact(text, G)).not.toThrow();
    gc?.();
    const vor = process.memoryUsage().heapUsed;
    const t = performance.now();
    const seg = zerlegeEdifact(text);
    const dauer = performance.now() - t;
    gc?.();
    const zuwachs = process.memoryUsage().heapUsed - vor;
    expect(seg.length).toBeGreaterThan(70_000);
    // ohne --expose-gc enthält die Messung auch Müll → gleiche Schwelle, ist dann großzügig
    expect(zuwachs).toBeLessThan(100 * 1024 * 1024);
    expect(dauer).toBeLessThan(1000);
  });
});
