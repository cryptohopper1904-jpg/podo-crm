import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  erzeugeNutzdatendatei,
  Gkv302ValidierungsFehler,
  type Gkv302Fehler,
  type Nutzdatendatei,
  pruefeNutzdatendatei,
  statusFuerInv,
  zerlegeEdifact,
} from "./index";
import { maskiere } from "./edifact";
import { fallBetraege } from "./betraege";
import { TEST_IK, testDatei, testFall1, testFall2, testPraxis } from "./fixtures/testdaten";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "latin1");

function fehlerVon(d: Nutzdatendatei): Gkv302Fehler[] {
  try {
    erzeugeNutzdatendatei(d);
  } catch (e) {
    if (e instanceof Gkv302ValidierungsFehler) return e.fehler;
    throw e;
  }
  return [];
}

function mitFall(f: (fall: ReturnType<typeof testFall1>) => void): Nutzdatendatei {
  const d = testDatei();
  f(d.leistungserbringer[0].kostentraeger[0].rechnungen[0].faelle[0]);
  return d;
}

describe("Nutzdatendatei SLGA/SLLA:B – Golden Files", () => {
  it("TA1 V21 entspricht der Referenzdatei", () => {
    expect(erzeugeNutzdatendatei(testDatei()).text + "\n").toBe(fixture("golden-v21.edi"));
  });

  it("TA1 V22 unterscheidet sich nur in der Nachrichtenversion (UNH SLGA:22 / SLLA:22)", () => {
    // V22 gilt ab 01.02.2027, V21 bis 30.04.2027: beide am selben Erstelldatum vergleichen
    const erstellt = { datum: "2027-02-01", uhrzeit: "09:30" };
    const v22 = erzeugeNutzdatendatei(testDatei({ taVersion: "22", erstellt })).text;
    expect(v22 + "\n").toBe(fixture("golden-v22.edi"));
    expect(v22.replace(/:22:0:0/g, ":21:0:0")).toBe(erzeugeNutzdatendatei(testDatei({ erstellt })).text);
  });

  it("ohne Zeilenumbruch: Segmente direkt hintereinander, Inhalt identisch", () => {
    const r = erzeugeNutzdatendatei(testDatei({ zeilenumbruch: false }));
    expect(r.text).not.toContain("\n");
    expect(r.text).toBe(fixture("golden-v21.edi").replace(/\n/g, ""));
    expect(r.bytes.length).toBe(r.text.length);
    // Byte-genau gegen die in ISO 8859-1 abgelegte Referenz
    const golden = readFileSync(path.join(__dirname, "fixtures", "golden-v21.edi"));
    expect(Buffer.from(r.bytes).equals(Buffer.from(golden.filter((b) => b !== 0x0a)))).toBe(true);
  });

  it("Zeichensatz ISO 8859-1: Umlaute als ein Byte", () => {
    const r = erzeugeNutzdatendatei(testDatei({ zeilenumbruch: false }));
    const i = r.text.indexOf("ß");
    expect(i).toBeGreaterThan(0);
    expect(r.bytes[i]).toBe(0xdf);
  });
});

describe("Aufbau nach TA1", () => {
  const r = erzeugeNutzdatendatei(testDatei());
  const segmente = zerlegeEdifact(r.text);

  it("UNB nach TA1 5.4 und logischer Dateiname nach Anhang 1 4.2", () => {
    expect(segmente[0].kennung).toBe("UNB");
    expect(r.text.split("\n")[0]).toBe("UNB+UNOC:3+990010013+990030017+20261102:0930+00001+B+SL001001S10+0'");
    expect(r.logischerDateiname).toBe("SL001001S10");
  });

  it("UNT zählt die Segmente der Nachricht inkl. UNH/UNT, UNZ die Nachrichten", () => {
    let start = -1;
    let nachrichten = 0;
    segmente.forEach((s, i) => {
      if (s.kennung === "UNH") {
        start = i;
        nachrichten++;
      }
      if (s.kennung === "UNT") {
        expect(Number(s.elemente[0][0])).toBe(i - start + 1);
        expect(s.elemente[1][0]).toBe(segmente[start].elemente[0][0]);
      }
    });
    const unz = segmente[segmente.length - 1];
    expect(unz.kennung).toBe("UNZ");
    expect(Number(unz.elemente[0][0])).toBe(nachrichten);
    expect(r.anzahlNachrichten).toBe(4);
  });

  it("Segmentfolge SLLA:B: INV NAD {EHE [TXT]} ZHE {DIA} [SKZ] BES", () => {
    const folge = segmente.map((s) => s.kennung).join(" ");
    expect(folge).toContain("FKT REC INV NAD EHE EHE TXT EHE EHE ZHE DIA BES UNT");
    expect(folge).toContain("FKT REC INV NAD EHE ZHE DIA SKZ BES UNT");
  });

  it("je Gesamtrechnung ein Paar SLGA + SLLA, GES 00 zuerst", () => {
    const unh = segmente.filter((s) => s.kennung === "UNH").map((s) => s.elemente[1][0]);
    expect(unh).toEqual(["SLGA", "SLLA", "SLGA", "SLLA"]);
    const ges = segmente.filter((s) => s.kennung === "GES").map((s) => s.elemente[0][0]);
    expect(ges).toEqual(["00", "11", "00", "31"]);
  });

  it("Referenz-Beispiel TA1 5.1 (S. 13): +D?'Angelo+Luigi+", () => {
    expect(r.text).toContain("NAD+D?'Angelo+Luigi+");
    expect(maskiere("D'Angelo")).toBe("D?'Angelo");
  });

  it("Steuerzeichen in Textfeldern werden aufgehoben, auch das Komma (TA1 5.1)", () => {
    expect(maskiere("a:b+c,d?e'f")).toBe("a?:b?+c?,d??e?'f");
    expect(r.text).toContain("Nagelrand?, schmerzhaft?: links?+rechts");
    // Parser hebt die Maskierung wieder auf
    const zhe = segmente.filter((s) => s.kennung === "ZHE")[1];
    expect(zhe.elemente[13][0]).toBe("Nagelrand, schmerzhaft: links+rechts");
  });

  it("ZHE: Ersatzwerte 999999999 bei fehlender BSNR/LANR, Behandlungsbeginn leer, Frequenz 0", () => {
    expect(r.text).toContain("ZHE+999999999+999999999+20260928+1+NF+03+++++1++0001+");
  });

  it("Beleginformation, Versichertenstatus 5-stellig (TA1 S. 46)", () => {
    expect(statusFuerInv("1000100")).toBe("10001");
    expect(statusFuerInv("1")).toBe("10000");
    expect(statusFuerInv("18000")).toBe("18000");
    expect(statusFuerInv(undefined)).toBeUndefined();
  });
});

describe("Beträge (TA1 Berechnungsregeln EHE/MWS/BES/GES)", () => {
  it("prozentuale Zuzahlung je Einheit kaufmännisch gerundet, Pauschale 10,00 je Verordnung", () => {
    const b = fallBetraege(testFall1(), 10, 1000);
    expect(b.positionen.map((p) => p.zuzahlungJeEinheitCent)).toEqual([356, 120, 45, 356]);
    expect(b.bruttoCent).toBe(8760);
    expect(b.prozentualeZuzahlungCent).toBe(877);
    expect(b.pauschaleZuzahlungCent).toBe(1000);
    expect(b.gesetzlicheZuzahlungCent).toBe(1877);
  });

  it("Pauschale höchstens Brutto minus prozentuale Zuzahlung", () => {
    const fall = testFall1();
    fall.leistungen = [{ positionsnummer: "99901", anzahl: 1, einzelpreisCent: 800, datum: "2026-10-05", zuzahlungsfaehig: true }];
    const b = fallBetraege(fall, 10, 1000);
    expect(b.prozentualeZuzahlungCent).toBe(80);
    expect(b.pauschaleZuzahlungCent).toBe(720);
  });

  it("zuzahlungsbefreit: keine Zuzahlung, BES nur Brutto", () => {
    const b = fallBetraege(testFall2(), 10, 1000);
    expect(b.gesetzlicheZuzahlungCent).toBe(0);
    expect(b.bruttoCent).toBe(7110);
  });

  it("MWS: Betrag = netto × Anzahl × Satz; Zuzahlung auf Bruttopreis je Einheit", () => {
    const d = mitFall((f) => {
      f.leistungen = [{ positionsnummer: "99901", anzahl: 3, einzelpreisCent: 1001, datum: "2026-10-05", mehrwertsteuerProzent: 19, zuzahlungsfaehig: true }];
    });
    d.leistungserbringer[0].praxis.mehrwertsteuerVereinbart = true;
    const r = erzeugeNutzdatendatei(d);
    // 10,01 × 3 × 19 % = 5,7057 → 5,71; Zuzahlung (10,01 + 1,90) × 10 % = 1,191 → 1,19
    expect(r.text).toContain("EHE+71:50000+99901+3,00+10,01+20261005+1,19'\nMWS+19,00+5,71'");
    expect(r.text).toContain("BES+35,74+13,57+3,57+10,00'");
  });

  it("GES 00 = Summe der Status-Summen; Rechnungsbetrag = Brutto − Zuzahlung", () => {
    const r = erzeugeNutzdatendatei(testDatei());
    const g = r.gesamtrechnungen[0].summen;
    expect(g[0]).toEqual({ status: "00", rechnungsbetragCent: 6883, bruttoCent: 8760, zuzahlungCent: 1877 });
    expect(g[1].rechnungsbetragCent).toBe(g[0].rechnungsbetragCent);
  });
});

describe("Korrekturverfahren und Sammelrechnung", () => {
  it("VKZ 04: URI-Segment nach INV und pauschaler Korrekturabzug in BES und GES", () => {
    const d = mitFall((f) => {
      f.urspruenglich = { ikLeistungserbringer: TEST_IK.praxis, sammelRechnungsnummer: "2026-09/0007", einzelRechnungsnummer: "0", rechnungsdatum: "2026-10-01", belegnummer: "4" };
      f.pauschalerKorrekturabzugCent = 500;
    });
    const rechnungen = d.leistungserbringer[0].kostentraeger[0].rechnungen;
    rechnungen[0].verarbeitungskennzeichen = "04";
    rechnungen.splice(1, 1);
    const r = erzeugeNutzdatendatei(d);
    expect(r.text).toContain("INV+X000000001+10000+1+1'\nURI+990010013+2026-09/0007:0+20261001+4'\nNAD+");
    expect(r.text).toContain("BES+87,60+18,77+8,77+10,00+5,00'");
    expect(r.text).toContain("GES+00+63,83+87,60+23,77'");
  });

  it("VKZ 03: GZF statt BES, Bruttobetrag 0,00 (Grund ZK 2, mit Nachweis § 43c)", () => {
    const d = mitFall((f) => {
      f.urspruenglich = { ikLeistungserbringer: TEST_IK.praxis, sammelRechnungsnummer: "2026-09/0007", einzelRechnungsnummer: "0", rechnungsdatum: "2026-10-01", belegnummer: "1" };
      f.zuzahlungskennzeichen = "2";
      f.nachweisErfolgloserEinzug = { referenz: "Mahnung-2026-0815.pdf", datum: "2026-11-01" };
    });
    const rechnungen = d.leistungserbringer[0].kostentraeger[0].rechnungen;
    rechnungen[0].verarbeitungskennzeichen = "03";
    rechnungen.splice(1, 1);
    const r = erzeugeNutzdatendatei(d);
    expect(r.text).toContain("ZHE+999000001+999000101+20261001+2+DF");
    expect(r.text).toContain("GZF+18,77+8,77+10,00'");
    expect(r.text).not.toContain("BES+");
    expect(r.text).toContain("GES+00+18,77+0,00+18,77'");
  });

  it("Sammelrechnung je Kostenträger: Sammel-SLGA mit „J“, Gesamtrechnungen mit Sammel:Einzel-Nummer", () => {
    const d = testDatei();
    const kt = d.leistungserbringer[0].kostentraeger[0];
    kt.sammelrechnung = { rechnungsnummer: "S2026-10", rechnungsdatum: "2026-11-02" };
    kt.rechnungen[0].rechnungsnummer = "1";
    kt.rechnungen[1].rechnungsnummer = "2";
    const r = erzeugeNutzdatendatei(d);
    const zeilen = r.text.split("\n");
    expect(zeilen[1]).toBe("UNH+00001+SLGA:21:0:0'");
    expect(zeilen[2]).toBe("FKT+01+J+990010013+990020026++990010013'");
    expect(zeilen[3]).toBe("REC+S2026-10:0+20261102+1'");
    expect(r.text).toContain("GES+00+139,93+158,70+18,77'");
    expect(r.text).toContain("REC+S2026-10:1+20261102+1'");
    expect(r.text).toContain("REC+S2026-10:2+20261102+1'");
    expect(r.anzahlNachrichten).toBe(5);
  });
});

describe("Validierung – deutsche Fehlermeldungen je Fehlerart", () => {
  it("gültige Testdaten haben keine Fehler", () => {
    expect(pruefeNutzdatendatei(testDatei())).toEqual([]);
  });

  it("pflichtfeld: Diagnose ohne ICD-10 und ohne Text", () => {
    const f = fehlerVon(mitFall((fall) => (fall.verordnung.diagnosen = [{}])));
    expect(f).toContainEqual(expect.objectContaining({ art: "pflichtfeld", meldung: expect.stringContaining("ICD-10-Code oder") }));
  });

  it("pflichtfeld (Segmentebene): leerer Nachname im NAD", () => {
    const f = fehlerVon(mitFall((fall) => (fall.versicherter.nachname = "")));
    expect(f).toContainEqual(expect.objectContaining({ art: "pflichtfeld", pfad: expect.stringContaining("NAD/Vers.-Nachname"), meldung: "Muss-Feld „Vers.-Nachname“ fehlt." }));
  });

  it("laenge: Belegnummer über 10 Stellen, Rechnungsnummer über 14 Stellen", () => {
    const d = mitFall((fall) => (fall.belegnummer = "12345678901"));
    d.leistungserbringer[0].kostentraeger[0].rechnungen[1].rechnungsnummer = "R2026-10-000000001";
    const f = fehlerVon(d);
    expect(f).toContainEqual(expect.objectContaining({ art: "laenge", meldung: "„Belegnummer“ darf höchstens 10 Stellen haben, erhalten: 11." }));
    expect(f).toContainEqual(expect.objectContaining({ art: "laenge", pfad: expect.stringContaining("Sammel-Rechnungsnummer") }));
  });

  it("laenge: Abrechnungspositionsnummer nicht 5-stellig", () => {
    const f = fehlerVon(mitFall((fall) => (fall.leistungen[0].positionsnummer = "9990")));
    expect(f).toContainEqual(expect.objectContaining({ art: "laenge", meldung: expect.stringContaining("5-stellig") }));
  });

  it("format: ungültiges Datum, Buchstaben in LANR, Rechnungsnummer mit Leerzeichen", () => {
    const d = mitFall((fall) => {
      fall.verordnung.verordnungsdatum = "2026-02-30";
      fall.verordnung.lanr = "12A";
    });
    d.leistungserbringer[0].kostentraeger[0].rechnungen[0].rechnungsnummer = "RE 1";
    const f = fehlerVon(d);
    expect(f).toContainEqual(expect.objectContaining({ art: "format", meldung: "Verordnungsdatum „2026-02-30“ ist kein gültiges Datum (Format JJJJ-MM-TT)." }));
    expect(f).toContainEqual(expect.objectContaining({ art: "format", meldung: expect.stringContaining("Lebenslange Arztnummer") }));
    expect(f).toContainEqual(expect.objectContaining({ art: "format", meldung: expect.stringContaining("unzulässige Zeichen") }));
  });

  it("format: Rechnungsnummer mit doppeltem Gliederungszeichen", () => {
    const d = testDatei();
    d.leistungserbringer[0].kostentraeger[0].rechnungen[0].rechnungsnummer = "2026--1";
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ meldung: expect.stringContaining("aufeinanderfolgende Gliederungszeichen") }));
  });

  it("schluessel: Abrechnungscode, Tarifkennzeichen, Verordnungsart, Genehmigungsart", () => {
    const d = mitFall((fall) => {
      fall.verordnung.verordnungsart = "01" as never;
      fall.verordnung.genehmigung = { kennzeichen: "X", datum: "2026-10-01", art: "B1" as never };
    });
    d.leistungserbringer[0].praxis = testPraxis({ abrechnungscode: "22" as never, tarifkennzeichen: "30a00" });
    const f = fehlerVon(d);
    expect(f).toContainEqual(expect.objectContaining({ art: "schluessel", meldung: expect.stringContaining("Abrechnungscode „22“") }));
    expect(f).toContainEqual(expect.objectContaining({ art: "schluessel", meldung: expect.stringContaining("Tarifkennzeichen „30a00“") }));
    // Segmentfehler kommen erst nach bestandener fachlicher Prüfung; hier eigener Lauf
    const g = fehlerVon(mitFall((fall) => {
      fall.verordnung.verordnungsart = "01" as never;
      fall.verordnung.genehmigung = { kennzeichen: "X", datum: "2026-10-01", art: "B1" as never };
    }));
    expect(g).toContainEqual(expect.objectContaining({ art: "schluessel", meldung: "„Kennzeichen Verordnungsart bei Heilmitteln“: Wert „01“ ist nicht zulässig (erlaubt: 03, 04, 05, 99)." }));
    expect(g).toContainEqual(expect.objectContaining({ art: "schluessel", pfad: expect.stringContaining("SKZ/Art der Genehmigung") }));
  });

  it("schluessel: Verarbeitungskennzeichen 10 ist für Podologie nicht zulässig", () => {
    const d = testDatei();
    d.leistungserbringer[0].kostentraeger[0].rechnungen[0].verarbeitungskennzeichen = "10" as never;
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "schluessel", meldung: expect.stringContaining("nur für Physiotherapie") }));
  });

  it("zeichensatz: Euro-Zeichen ist in UNOC (ISO 8859-1) nicht darstellbar", () => {
    const f = fehlerVon(mitFall((fall) => (fall.leistungen[1].text = "Hausbesuch 12 €")));
    expect(f).toContainEqual(expect.objectContaining({ art: "zeichensatz", meldung: "„Text“ enthält das Zeichen „€“, das im Zeichensatz UNOC (ISO 8859-1) nicht darstellbar ist." }));
  });

  it("pruefziffer: IK der Krankenkasse mit falscher Prüfziffer", () => {
    const d = testDatei();
    d.leistungserbringer[0].kostentraeger[0].rechnungen[0].kasseIk = "990020016";
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "pruefziffer", meldung: "IK der Krankenkasse „990020016“ hat eine ungültige Prüfziffer." }));
  });

  it("kombination: ohne Versichertennummer ist die Anschrift Pflicht", () => {
    const f = fehlerVon(mitFall((fall) => (fall.versicherter.versichertennummer = undefined)));
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("Anschrift") }));
  });

  it("kombination: patientenindividuelle Leitsymptomatik ohne Text, Therapiefrequenz ≠ 0", () => {
    const f = fehlerVon(mitFall((fall) => {
      fall.verordnung.leitsymptomatik = { art: "heilmittelrichtlinie", a: false, b: false, c: false, patientenindividuell: false };
      fall.verordnung.therapiefrequenz = 2;
    }));
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", pfad: expect.stringContaining("leitsymptomatikText") }));
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("Therapiefrequenz „0“") }));
  });

  it("kombination: gleiche Position am selben Tag doppelt, Belegnummer doppelt", () => {
    const d = mitFall((fall) => fall.leistungen.push({ ...fall.leistungen[0] }));
    d.leistungserbringer[0].kostentraeger[0].rechnungen[0].faelle.push({ ...testFall2(), belegnummer: "1" });
    const f = fehlerVon(d);
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("zusammenzufassen") }));
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("nicht eindeutig") }));
  });

  it("kombination: Rechnungsnummer doppelt vergeben", () => {
    const d = testDatei();
    d.leistungserbringer[0].kostentraeger[0].rechnungen[1].rechnungsnummer = "2026-10/0001";
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("mehrfach vergeben") }));
  });

  it("kombination: Korrekturverfahren ohne URI bzw. Regelabrechnung mit URI", () => {
    const d = testDatei();
    d.leistungserbringer[0].kostentraeger[0].rechnungen[0].verarbeitungskennzeichen = "02";
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "pflichtfeld", meldung: expect.stringContaining("(URI) Pflicht") }));
  });

  it("kombination: Rechnungsart 1 verlangt Absender = Leistungserbringer und „S“", () => {
    const d = testDatei({ absender: { ik: TEST_IK.abrechnungsstelle, art: "A", name: "Test-Abrechnungsstelle", anschrift: { strasse: "Weg 1", plz: "10115", ort: "Berlin" } } });
    const f = fehlerVon(d);
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", pfad: "absender.ik" }));
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", pfad: "absender.art" }));
    // mit Rechnungsart 2 zulässig (Modell b: Abrechnungsstelle ohne Inkasso)
    const r = erzeugeNutzdatendatei({ ...d, rechnungsart: "2" });
    expect(r.logischerDateiname).toBe("SL005001A10");
    expect(r.text).toContain("FKT+01++990010013+990020026+990020015+990050012'");
    expect(r.text).toContain("REC+2026-10/0001:0+20261102+2'");
  });

  it("Zuzahlungskennzeichen 4/5 verlangen Angaben je Position", () => {
    const f = fehlerVon(mitFall((fall) => (fall.zuzahlungskennzeichen = "4")));
    expect(f.filter((x) => x.pfad.endsWith("zuzahlungspflichtig"))).toHaveLength(4);
    expect(f).toContainEqual(expect.objectContaining({ pfad: expect.stringContaining("pauschaleZuzahlung") }));
  });

  it("Fehlerobjekt enthält alle Meldungen im Text", () => {
    try {
      erzeugeNutzdatendatei(testDatei({ datenaustauschreferenz: 0, abrechnungsmonat: 13 }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Gkv302ValidierungsFehler);
      expect((e as Error).message).toContain("Datenaustauschreferenz muss zwischen 1 und 99999 liegen.");
      expect((e as Error).message).toContain("Abrechnungsmonat muss zwischen 1 und 12 liegen.");
    }
  });
});

// ───────────── Review-Runde 1: Blocker (zuerst als fehlschlagende Tests geschrieben) ─────────────

/** Datei mit genau einer Gesamtrechnung (Fall 1) im angegebenen Verarbeitungskennzeichen */
function korrekturDatei(vkz: "02" | "03" | "04", f: (fall: ReturnType<typeof testFall1>) => void = () => {}): Nutzdatendatei {
  const d = mitFall((fall) => {
    fall.urspruenglich = { ikLeistungserbringer: TEST_IK.praxis, sammelRechnungsnummer: "2026-09/0007", einzelRechnungsnummer: "0", rechnungsdatum: "2026-10-01", belegnummer: "1" };
    f(fall);
  });
  const rechnungen = d.leistungserbringer[0].kostentraeger[0].rechnungen;
  rechnungen[0].verarbeitungskennzeichen = vkz;
  rechnungen.splice(1, 1);
  return d;
}

const NACHWEIS = { referenz: "Mahnung-2026-0815.pdf", datum: "2026-11-01" };

describe("B1/C3 VKZ 03: Zuzahlung unabhängig vom Zuzahlungskennzeichen (TA1 V21 7.4.2, S. 167–168)", () => {
  it("ZK 2 (Zahlung verweigert): prozentuale Zuzahlung je Position + Pauschale", () => {
    const r = erzeugeNutzdatendatei(korrekturDatei("03", (fall) => {
      fall.zuzahlungskennzeichen = "2";
      fall.nachweisErfolgloserEinzug = NACHWEIS;
    }));
    expect(r.text).toContain("GZF+18,77+8,77+10,00'");
    expect(r.text).toContain("EHE+71:50000+99901+1,00+35,55+20261005+3,56'");
    expect(r.text).toContain("GES+00+18,77+0,00+18,77'");
  });

  it("ZK 1 (Befreiung nachträglich): nur die übermittelten Teile der Termine zählen", () => {
    const r = erzeugeNutzdatendatei(korrekturDatei("03", (fall) => {
      fall.zuzahlungskennzeichen = "1";
      fall.leistungen = fall.leistungen.filter((l) => l.positionsnummer === "99901");
    }));
    // 2 × 3,56 + Pauschale 10,00
    expect(r.text).toContain("GZF+17,12+7,12+10,00'");
  });

  it("ZK 5: Zuzahlung nur für Positionen mit zuzahlungspflichtig = true, Pauschale nur mit pauschaleZuzahlung = true (R2-2/F2)", () => {
    const b = fallBetraege({ ...testFall1(), zuzahlungskennzeichen: "5", pauschaleZuzahlung: true, leistungen: testFall1().leistungen.map((l, i) => ({ ...l, zuzahlungspflichtig: i !== 0 })) }, 10, 1000, "03");
    expect(b.prozentualeZuzahlungCent).toBe(877 - 356);
    expect(b.pauschaleZuzahlungCent).toBe(1000);
  });
});

describe("R2-2/F2 VKZ 03 + ZK 5: Angabe je Position und Pauschale verpflichtend, kein Standard „ja“ (TA1 V21 7.4.2.3, S. 168)", () => {
  it("ohne Angaben fällt keine Zuzahlung an", () => {
    const b = fallBetraege({ ...testFall1(), zuzahlungskennzeichen: "5" }, 10, 1000, "03");
    expect(b.prozentualeZuzahlungCent).toBe(0);
    expect(b.pauschaleZuzahlungCent).toBe(0);
  });

  it("fehlende Angaben → Pflichtfeld-Fehler je Position und für die Pauschale", () => {
    const f = fehlerVon(korrekturDatei("03", (fall) => {
      fall.zuzahlungskennzeichen = "5";
      fall.nachweisErfolgloserEinzug = NACHWEIS;
    }));
    expect(f).toContainEqual(expect.objectContaining({ art: "pflichtfeld", pfad: expect.stringContaining("pauschaleZuzahlung") }));
    expect(f).toContainEqual(expect.objectContaining({ art: "pflichtfeld", pfad: expect.stringContaining("leistungen[0].zuzahlungspflichtig") }));
  });

  it("mit Angaben: nur die Positionen nach dem Statuswechsel", () => {
    const r = erzeugeNutzdatendatei(korrekturDatei("03", (fall) => {
      fall.zuzahlungskennzeichen = "5";
      fall.nachweisErfolgloserEinzug = NACHWEIS;
      fall.pauschaleZuzahlung = false;
      fall.leistungen.forEach((l) => (l.zuzahlungspflichtig = l.datum === "2026-10-19"));
    }));
    expect(r.text).toContain("GZF+3,56+3,56+0,00'");
  });

  it("ZK 1/2 bleiben beim Standard „alle übermittelten Positionen“", () => {
    const b = fallBetraege({ ...testFall1(), zuzahlungskennzeichen: "2" }, 10, 1000, "03");
    expect(b.prozentualeZuzahlungCent).toBe(877);
    expect(b.pauschaleZuzahlungCent).toBe(1000);
  });
});

describe("B2 VKZ 03: nur mit ZK 1/2/5, Zuzahlung > 0, Nachweis § 43c (TA1 V21 7.4.2, S. 167–168)", () => {
  it("ZK 3 und ZK 0 sind bei VKZ 03 unzulässig", () => {
    for (const zk of ["3", "0"] as const) {
      const f = fehlerVon(korrekturDatei("03", (fall) => (fall.zuzahlungskennzeichen = zk)));
      expect(f).toContainEqual(expect.objectContaining({ art: "kombination", pfad: expect.stringContaining("zuzahlungskennzeichen"), meldung: expect.stringContaining("1, 2 oder 5") }));
    }
  });

  it("ZK 2/5 ohne Nachweis über den erfolglosen Einzug → Pflichtfeld", () => {
    const f = fehlerVon(korrekturDatei("03", (fall) => (fall.zuzahlungskennzeichen = "2")));
    expect(f).toContainEqual(expect.objectContaining({ art: "pflichtfeld", pfad: expect.stringContaining("nachweisErfolgloserEinzug") }));
  });

  it("Forderung 0,00 ist unzulässig", () => {
    const f = fehlerVon(korrekturDatei("03", (fall) => {
      fall.zuzahlungskennzeichen = "2";
      fall.nachweisErfolgloserEinzug = NACHWEIS;
      fall.pauschaleZuzahlung = false;
      fall.leistungen.forEach((l) => (l.zuzahlungspflichtig = false));
    }));
    expect(f).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("größer 0") }));
  });
});

describe("B3/C2 genau ein Verarbeitungskennzeichen je Datei (TA1 V21 7.3, S. 166)", () => {
  it("VKZ 01 und 02 in derselben Datei → Fehler", () => {
    const d = testDatei();
    const r2 = d.leistungserbringer[0].kostentraeger[0].rechnungen[1];
    r2.verarbeitungskennzeichen = "02";
    r2.faelle[0].urspruenglich = { ikLeistungserbringer: TEST_IK.praxis, sammelRechnungsnummer: "2026-09/0008", einzelRechnungsnummer: "0", rechnungsdatum: "2026-10-01", belegnummer: "2" };
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "kombination", pfad: "verarbeitungskennzeichen", meldung: expect.stringContaining("eigene Datei") }));
  });
});

describe("C1 kein Mischen von Einzel- und Sammelrechnungen in einer Datei (TA1 V21 5.3.2 S. 15, 5.3.3 S. 16)", () => {
  it("ein Kostenträger mit, einer ohne Sammelrechnung → Fehler", () => {
    const d = testDatei();
    const kts = d.leistungserbringer[0].kostentraeger;
    const [r1, r2] = kts[0].rechnungen;
    kts[0] = { kostentraegerIk: TEST_IK.kostentraeger, sammelrechnung: { rechnungsnummer: "S2026-10", rechnungsdatum: "2026-11-02" }, rechnungen: [{ ...r1, rechnungsnummer: "1" }] };
    kts.push({ kostentraegerIk: TEST_IK.kasse, rechnungen: [r2] });
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("Mischen von Einzel- und Sammelrechnungen") }));
  });
});

describe("C5 TA-Version passend zum Erstelldatum (TA1 V22 Deckblatt und 5.5.1, S. 1/29)", () => {
  it("V22 erst ab 01.02.2027, V21 nur bis 30.04.2027", () => {
    expect(fehlerVon(testDatei({ taVersion: "22", erstellt: { datum: "2027-01-31", uhrzeit: "09:30" } }))).toContainEqual(expect.objectContaining({ pfad: "taVersion", meldung: expect.stringContaining("01.02.2027") }));
    expect(fehlerVon(testDatei({ taVersion: "21", erstellt: { datum: "2027-05-01", uhrzeit: "09:30" } }))).toContainEqual(expect.objectContaining({ pfad: "taVersion", meldung: expect.stringContaining("30.04.2027") }));
    expect(fehlerVon(testDatei({ taVersion: "21", erstellt: { datum: "2025-09-30", uhrzeit: "09:30" } }))).toContainEqual(expect.objectContaining({ pfad: "taVersion" }));
    expect(pruefeNutzdatendatei(testDatei({ taVersion: "22", erstellt: { datum: "2027-02-01", uhrzeit: "09:30" } }))).toEqual([]);
    expect(pruefeNutzdatendatei(testDatei({ taVersion: "21", erstellt: { datum: "2027-04-30", uhrzeit: "09:30" } }))).toEqual([]);
  });
});

// ───────────── Review-Runde 1: weitere Befunde ─────────────

describe("Korrekturverfahren VKZ 02 (TA1 V21 7.4.1, S. 166)", () => {
  it("Nachforderung: URI nach INV, BES wie Regelabrechnung", () => {
    const r = erzeugeNutzdatendatei(korrekturDatei("02", (fall) => (fall.leistungen = [fall.leistungen[1]])));
    expect(r.text).toContain("FKT+02++990010013+990020026+990020015'");
    expect(r.text).toContain("URI+990010013+2026-09/0007:0+20261001+1'");
    // 12,00 brutto, 1,20 prozentual, Pauschale höchstens 12,00 − 1,20 = 10,80 → 10,00
    expect(r.text).toContain("BES+12,00+11,20+1,20+10,00'");
  });
});

describe("B5 Kilometer mit Nachkommastellen (Rundung je Position)", () => {
  it("12,5 km × 0,30 €: Brutto 3,75, Zuzahlung je km 0,03, Position 0,375 → 0,38", () => {
    const d = mitFall((f) => {
      f.leistungen = [{ positionsnummer: "99904", anzahl: 12.5, einzelpreisCent: 30, datum: "2026-10-05" }];
      f.pauschaleZuzahlung = undefined;
    });
    const r = erzeugeNutzdatendatei(d);
    expect(r.text).toContain("EHE+71:50000+99904+12,50+0,30+20261005+0,03'");
    const b = r.gesamtrechnungen[0].faelle[0].betraege;
    expect(b.bruttoCent).toBe(375);
    expect(b.prozentualeZuzahlungCent).toBe(38);
    // Pauschale höchstens Brutto − prozentual
    expect(b.pauschaleZuzahlungCent).toBe(337);
  });

  it("R2-3 Lesart „..4,2“ = 4 Stellen insgesamt: 99,50 km zulässig, 120,50 km zu lang", () => {
    const d = mitFall((f) => (f.leistungen = [{ positionsnummer: "99904", anzahl: 99.5, einzelpreisCent: 30, datum: "2026-10-05" }]));
    expect(erzeugeNutzdatendatei(d).text).toContain("+99,50+0,30+");
    const zuViel = mitFall((f) => (f.leistungen = [{ positionsnummer: "99904", anzahl: 120.5, einzelpreisCent: 30, datum: "2026-10-05" }]));
    expect(fehlerVon(zuViel)).toContainEqual(expect.objectContaining({ art: "laenge", meldung: expect.stringContaining("5 Stellen, erlaubt sind höchstens 4") }));
  });

  it("R2-3 MWS-Satz „..5,2“: 19,00 zulässig, 1000,00 zu lang; Betrag ohne führende Nullen gezählt", () => {
    const d = mitFall((f) => (f.leistungen[0].mehrwertsteuerProzent = 19));
    d.leistungserbringer[0].praxis.mehrwertsteuerVereinbart = true;
    expect(fehlerVon(d)).toEqual([]);
    const zuViel = mitFall((f) => (f.leistungen[0].mehrwertsteuerProzent = 1000));
    zuViel.leistungserbringer[0].praxis.mehrwertsteuerVereinbart = true;
    expect(fehlerVon(zuViel)).toContainEqual(expect.objectContaining({ art: "laenge", pfad: expect.stringContaining("Mehrwertsteuersatz") }));
  });
});

describe("B6/D1 Zuzahlungspflicht je Position aus der Vergütungsliste", () => {
  it("ZK 3: Position mit zuzahlungsfaehig = false erhält keinen Zuzahlungsbetrag", () => {
    const fall = testFall1();
    fall.leistungen[1].zuzahlungsfaehig = false;
    const b = fallBetraege(fall, 10, 1000);
    expect(b.positionen.map((p) => p.zuzahlungJeEinheitCent)).toEqual([356, 0, 45, 356]);
    expect(b.prozentualeZuzahlungCent).toBe(757);
  });

  it("ohne Angabe gilt die Position als zuzahlungspflichtig (Standard ja)", () => {
    const fall = testFall1();
    fall.leistungen.forEach((l) => delete l.zuzahlungsfaehig);
    expect(fallBetraege(fall, 10, 1000).prozentualeZuzahlungCent).toBe(877);
  });
});

describe("B7 MWS bei Podologie nur mit Freischaltung (TA1 V21 5.5.3.3 MWS, S. 56)", () => {
  const mitMws = () => mitFall((f) => (f.leistungen[0].mehrwertsteuerProzent = 19));
  it("ohne mehrwertsteuerVereinbart → Fehler", () => {
    expect(fehlerVon(mitMws())).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("mehrwertsteuerVereinbart") }));
  });
  it("UST befreit + MWS → Fehler, auch mit Freischaltung", () => {
    const d = mitMws();
    d.leistungserbringer[0].praxis = testPraxis({ mehrwertsteuerVereinbart: true, umsatzsteuer: { steuernummer: "00/000/00000", befreit: true } });
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("umsatzsteuerbefreit") }));
  });
});

describe("B8 Rechnungsnummern eindeutig, auch innerhalb einer Sammelrechnung", () => {
  it("doppelte Einzel-Rechnungsnummer in der Sammelrechnung → Fehler", () => {
    const d = testDatei();
    const kt = d.leistungserbringer[0].kostentraeger[0];
    kt.sammelrechnung = { rechnungsnummer: "S2026-10", rechnungsdatum: "2026-11-02" };
    kt.rechnungen[0].rechnungsnummer = "1";
    kt.rechnungen[1].rechnungsnummer = "1";
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "kombination", meldung: expect.stringContaining("Einzel-Rechnungsnummer „1“ ist in der Sammelrechnung") }));
  });

  it("Einzel-Rechnungsnummer „0“ kollidiert mit der Sammelrechnungs-SLGA", () => {
    const d = testDatei();
    const kt = d.leistungserbringer[0].kostentraeger[0];
    kt.sammelrechnung = { rechnungsnummer: "S2026-10", rechnungsdatum: "2026-11-02" };
    kt.rechnungen[0].rechnungsnummer = "0";
    kt.rechnungen[1].rechnungsnummer = "2";
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ meldung: expect.stringContaining("mehrfach vergeben") }));
  });

  it("gleiche Rechnungsnummer bei zwei Kostenträgern desselben Leistungserbringers → Fehler", () => {
    const d = testDatei();
    const kts = d.leistungserbringer[0].kostentraeger;
    const r2 = kts[0].rechnungen.pop()!;
    kts.push({ kostentraegerIk: TEST_IK.kasse, rechnungen: [{ ...r2, rechnungsnummer: "2026-10/0001" }] });
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ meldung: expect.stringContaining("mehrfach vergeben") }));
  });
});

describe("R2-3 SKO „..2,2“ als einzige Ausnahme (2 Vorkommastellen)", () => {
  it("Skonto 2,00 % zulässig, 100,00 % zu lang", () => {
    const d = testDatei();
    d.leistungserbringer[0].praxis.skonto = [{ prozent: 2, zahlungszielTage: 10 }];
    expect(erzeugeNutzdatendatei(d).text).toContain("SKO+2,00+10'");
    d.leistungserbringer[0].praxis.skonto = [{ prozent: 100, zahlungszielTage: 10 }];
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "laenge", pfad: expect.stringContaining("SKO/Skonto in Prozent") }));
  });
});

describe("Nice: Sondertarife und Heilmittelbereich", () => {
  it("Sondertarif 091–098, A91–A98 und U00–ZZZ sind nicht besetzt (Anlage 3 V21 8.1.5.2, S. 19)", () => {
    for (const tk of ["50091", "50A95", "50U00", "50ZZZ"]) {
      const d = testDatei();
      d.leistungserbringer[0].praxis = testPraxis({ tarifkennzeichen: tk });
      expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "schluessel", pfad: expect.stringContaining("tarifkennzeichen") }));
    }
    for (const tk of ["50000", "50A90", "50099", "50T12", "91B01"]) {
      const d = testDatei();
      d.leistungserbringer[0].praxis = testPraxis({ tarifkennzeichen: tk });
      expect(pruefeNutzdatendatei(d)).toEqual([]);
    }
  });

  it("Heilmittelbereich wird bei 71/72 mit „2“ vorbelegt", () => {
    const r = erzeugeNutzdatendatei(testDatei());
    expect(r.text).toContain("rechts+1+2+0'");
  });
});

describe("Review-Runde 2 Paket D: Verordnungsart Pflicht", () => {
  it("fehlendes Kennzeichen Verordnungsart → Pflichtfeldfehler, keine Datei", () => {
    const d = mitFall((fall) => {
      fall.verordnung.verordnungsart = undefined;
    });
    expect(fehlerVon(d)).toContainEqual(expect.objectContaining({ art: "pflichtfeld", pfad: expect.stringContaining("verordnung.verordnungsart") }));
  });
});
