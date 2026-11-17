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
    const v22 = erzeugeNutzdatendatei(testDatei({ taVersion: "22" })).text;
    expect(v22 + "\n").toBe(fixture("golden-v22.edi"));
    expect(v22.replace(/:22:0:0/g, ":21:0:0")).toBe(erzeugeNutzdatendatei(testDatei()).text);
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
    fall.leistungen = [{ positionsnummer: "99901", anzahl: 1, einzelpreisCent: 800, datum: "2026-10-05" }];
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
      f.leistungen = [{ positionsnummer: "99901", anzahl: 3, einzelpreisCent: 1001, datum: "2026-10-05", mehrwertsteuerProzent: 19 }];
    });
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

  it("VKZ 03: GZF statt BES, Bruttobetrag 0,00", () => {
    const d = mitFall((f) => {
      f.urspruenglich = { ikLeistungserbringer: TEST_IK.praxis, sammelRechnungsnummer: "2026-09/0007", einzelRechnungsnummer: "0", rechnungsdatum: "2026-10-01", belegnummer: "1" };
    });
    const rechnungen = d.leistungserbringer[0].kostentraeger[0].rechnungen;
    rechnungen[0].verarbeitungskennzeichen = "03";
    rechnungen.splice(1, 1);
    const r = erzeugeNutzdatendatei(d);
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
