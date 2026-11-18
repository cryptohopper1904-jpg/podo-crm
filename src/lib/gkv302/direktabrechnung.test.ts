/**
 * Prüflauf und Testpaket (Paket D) mit erfundenen Daten: IKs „99…“ mit gültiger Prüfziffer, erfundene Namen,
 * Kostenträgerdatei fixtures/kotr-test.ke0. Keine echten Personen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { begleitzettelPdf } from "./begleitzettel-pdf";
import {
  Nummernkreis,
  TestpaketFehler,
  WARNUNG_TEST,
  erzeugeTestpaket,
  kassenartAus,
  leererZaehlerstand,
  leitsymptomatikAus,
  praxisModell,
  pruefeFaelle,
  snapshotAus,
  taVersionFuer,
  zaehlerstandAus,
  type DaKotrDatei,
  type DaPraxis,
  type DaVerordnung,
} from "./direktabrechnung";
import { ausLatin1, zerlegeEdifact } from "./edifact";
import { leseAuftragssatz } from "./auftragsdatei";
import { parseKostentraegerdatei } from "./kostentraeger";
import { TEST_IK } from "./fixtures/testdaten";
import { ikMitPruefziffer } from "./ik";
import type { Kostentraegerdatei } from "./kostentraeger";

const kotrDatei = parseKostentraegerdatei(ausLatin1(new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "kotr-test.ke0")))));
const KOTR: DaKotrDatei[] = [{ datei: kotrDatei, kassenart: kassenartAus(kotrDatei.dateiname)! }];
const JETZT = { datum: "2026-11-18", uhrzeit: "10:15", sekunde: "30" };

const praxis = (ueber: Partial<DaPraxis> = {}): DaPraxis => ({
  ik: TEST_IK.praxis,
  name: "Podologie Testpraxis",
  strasse: "Teststraße 1",
  plz: "10115",
  ort: "Berlin",
  telefon: "030 0000000",
  email: "abrechnung@example.org",
  legsCode: "7100501",
  tarifkennzeichen: "50000",
  ...ueber,
});

const snapshot = (copay = 356) => ({
  rulesVersion: "test",
  computedOn: "2026-10-20",
  remedyCents: 7110,
  copaymentPercentCents: 712,
  flatFeeCents: 1000,
  copaymentCents: 1712,
  complete: true,
  lines: [
    { date: "2026-10-05", position: "78020", units: 1, priceCents: 3555, copayCents: copay, minor: false, exempt: false, tableVersion: "test" },
    { date: "2026-10-19", position: "78020", units: 1, priceCents: 3555, copayCents: 356, minor: false, exempt: false, tableVersion: "test" },
  ],
  notes: [],
});

let n = 0;
const vo = (ueber: Partial<DaVerordnung> = {}, patient: Partial<DaVerordnung["patient"]> = {}): DaVerordnung => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  anzeige: `Erika Testfall (#${n})`,
  issuedAt: "2026-10-01",
  doctorLanr: "999000101",
  doctorBsnr: "999000001",
  diagnosisGroup: "DF",
  icd10: "E11.74",
  diagnosisText: null,
  leitsymptomatik: "a",
  leitsymptomatikText: null,
  homeVisit: false,
  urgent: false,
  copaymentExempt: false,
  therapyReportRequested: false,
  externalRef: null,
  source: "paper",
  insurerIk: TEST_IK.kasse,
  insuranceNumber: "X000000001",
  insuredStatus: "1",
  priceSnapshot: snapshot(),
  verordnungsart: "03",
  ...ueber,
  patient: {
    lastName: "Testfall",
    firstName: "Erika",
    birthDate: "1950-04-12",
    street: "Musterweg 2",
    zip: "10115",
    city: "Berlin",
    insuranceNumber: null,
    insurerIk: null,
    insuredStatus: null,
    copaymentExemptions: [],
    ...patient,
  },
});

describe("Prüflauf § 302", () => {
  it("vollständiger Fall ist ok, mit Kostenträger/DAV aus der Kostenträgerdatei und Summen", () => {
    const e = pruefeFaelle(praxis(), [vo()], KOTR, JETZT.datum);
    expect(e.praxisFehler).toEqual([]);
    const f = e.faelle[0];
    expect(f.status).toBe("ok");
    expect(f.fehlendeAngaben).toEqual([]);
    expect(f.kostentraegerIk).toBe(TEST_IK.kostentraeger);
    expect(f.davIk).toBe(TEST_IK.davMitEntschluesselung);
    expect(f.physikalischerEmpfaengerIk).toBe(TEST_IK.davWeiterleitung);
    expect(f.kassenart).toBe("GK");
    expect(f.kasseName).toBe("Testkasse Nord");
    expect(f.betraege).toEqual({ bruttoCent: 7110, zuzahlungCent: 1712, rechnungsbetragCent: 5398 });
    expect(e.summen).toEqual([expect.objectContaining({ ik: TEST_IK.kostentraeger, faelleOk: 1, faelleGesamt: 1, rechnungsbetragCent: 5398 })]);
    expect(e.testpaketMoeglich).toBe(true);
  });

  it("ohne Verordnungsart (heute nicht gespeichert) → fehlende Angabe, nicht raten", () => {
    const f = pruefeFaelle(praxis(), [vo({ verordnungsart: null })], KOTR, JETZT.datum).faelle[0];
    expect(f.status).toBe("fehlend");
    expect(f.fehlendeAngaben.join(" ")).toContain("Verordnungsart");
    expect(f.betraege).toBeNull();
  });

  it("Abweichung im Preis-Snapshot sperrt den Fall (Text aus dem Adapter)", () => {
    const f = pruefeFaelle(praxis(), [vo({ priceSnapshot: snapshot(100) })], KOTR, JETZT.datum).faelle[0];
    expect(f.status).toBe("abweichung");
    expect(f.abweichungen.join(" ")).toContain("Zuzahlung im Preis-Snapshot 100 Cent, berechnet 356 Cent");
  });

  it("fehlender Snapshot, fehlende Leitsymptomatik und unbekannte Kasse werden gemeldet", () => {
    const e = pruefeFaelle(praxis(), [vo({ priceSnapshot: null, leitsymptomatik: null }), vo({ insurerIk: "990020037" })], KOTR, JETZT.datum);
    expect(e.faelle[0].status).toBe("fehlend");
    expect(e.faelle[0].fehlendeAngaben.join(" ")).toMatch(/Preis-Snapshot fehlt[\s\S]*Leitsymptomatik/);
    expect(e.faelle[1].fehlendeAngaben.join(" ")).toContain("Kostenträger/Datenannahmestelle nicht ermittelbar");
    expect(e.testpaketMoeglich).toBe(false);
  });

  it("TA1-Feldprüfung je Fall (z. B. zu langer Name) erscheint als fehlende Angabe", () => {
    const f = pruefeFaelle(praxis(), [vo({}, { lastName: "X".repeat(80) })], KOTR, JETZT.datum).faelle[0];
    expect(f.status).toBe("fehlend");
    expect(f.fehlendeAngaben.some((t) => t.startsWith("Prüfung TA1:"))).toBe(true);
  });

  it("ohne Kostenträgerdatei: Hinweis, Fall geprüft, aber keine Datei möglich", () => {
    const e = pruefeFaelle(praxis(), [vo()], [], JETZT.datum);
    expect(e.kotrVorhanden).toBe(false);
    expect(e.kotrHinweise[0]).toContain("Keine Kostenträgerdatei");
    expect(e.faelle[0].status).toBe("ok");
    expect(e.testpaketMoeglich).toBe(false);
    expect(() => erzeugeTestpaket(praxis(), [vo()], [], JETZT, new Nummernkreis(leererZaehlerstand(), "T"))).toThrow(TestpaketFehler);
  });

  it("Praxisdaten: IK, Leistungserbringergruppe, Tarifkennzeichen, Anschrift", () => {
    expect(praxisModell(praxis()).fehler).toEqual([]);
    const f = praxisModell(praxis({ ik: "990010014", tarifkennzeichen: null, legsCode: "2700541", strasse: null })).fehler.join(" ");
    expect(f).toContain("Prüfziffer");
    expect(f).toContain("Tarifkennzeichen fehlt");
    expect(f).toContain("2700541");
    expect(f).toContain("Anschrift");
    expect(praxisModell(praxis({ name: "Podologie mit einem sehr langen Praxisnamen GmbH" })).praxis!.name).toHaveLength(30);
    expect(praxisModell(praxis({ email: "büro@example.org" })).praxis!.email).toBeUndefined();
  });

  it("Hilfen: Leitsymptomatik, Snapshot-Form, TA-Version, Kassenart", () => {
    expect(leitsymptomatikAus("x", " Nagelpilz ")).toEqual({ leitsymptomatik: { art: "heilmittelrichtlinie", a: false, b: false, c: false, patientenindividuell: true }, leitsymptomatikText: "Nagelpilz" });
    expect(leitsymptomatikAus("x", null)).toEqual({});
    expect(snapshotAus({ lines: "kaputt" })).toBeNull();
    expect(snapshotAus([])).toBeNull();
    expect(taVersionFuer("2027-01-31")).toBe("21");
    expect(taVersionFuer("2027-02-01")).toBe("22");
    expect(kassenartAus("AO05Q426.KE2")).toBe("AO");
    expect(kassenartAus("AO05Q426KE2")).toBe("AO");
    expect(kassenartAus("rechnung.pdf")).toBeNull();
  });
});

describe("Testpaket § 302", () => {
  it("nimmt nur Fälle „ok“, kennzeichnet als Test und vergibt fortlaufende Nummern", async () => {
    const nummern = new Nummernkreis(leererZaehlerstand(), "T");
    const p = erzeugeTestpaket(praxis(), [vo(), vo({ verordnungsart: null }), vo({}, { lastName: "Beispiel", firstName: "Max" })], KOTR, JETZT, nummern);
    expect(p.ausgeschlossen).toBe(1);
    expect(p.uebersicht).toEqual([expect.objectContaining({ nutzdatei: "TSOL0000", auftragsdatei: "TSOL0000.AUF", davIk: TEST_IK.davMitEntschluesselung, kassenart: "GK", rechnungsnummern: ["T2026-00001"], faelle: 2 })]);
    const namen = p.dateien.map((d) => d.name);
    expect(namen[0]).toBe("LIESMICH_TEST_NICHT_VERSENDEN.txt");
    expect(new TextDecoder().decode(p.dateien[0].bytes)).toContain(WARNUNG_TEST);
    const nutz = p.dateien.find((d) => d.name.endsWith("/TSOL0000"))!;
    const segmente = zerlegeEdifact(ausLatin1(nutz.bytes));
    const unb = segmente[0];
    expect(unb.kennung).toBe("UNB");
    // Testindikator 0 (Testdatei), Empfänger = DAV mit Entschlüsselungsbefugnis
    expect(unb.elemente[unb.elemente.length - 1][0]).toBe("0");
    expect(unb.elemente[2][0]).toBe(TEST_IK.davMitEntschluesselung);
    expect(ausLatin1(nutz.bytes)).toContain("T2026-00001");
    // Belegnummern 1 und 2 in der Gesamtrechnung
    expect(segmente.filter((s) => s.kennung === "INV").map((s) => s.elemente[3][0])).toEqual(["1", "2"]);
    const auf = leseAuftragssatz(ausLatin1(p.dateien.find((d) => d.name.endsWith(".AUF"))!.bytes));
    expect(auf.verfahrenKennung).toBe("TSOL0");
    expect(auf.verschluesselungsart).toBe("00");
    expect(auf.empfaengerPhysikalisch).toBe(TEST_IK.davWeiterleitung);
    expect(auf.groesseNutzdaten).toBe(nutz.bytes.length);
    expect(auf.groesseUebertragung).toBe(nutz.bytes.length);
    const zettel = p.dateien.find((d) => d.name.includes("Begleitzettel_T2026-00001"))!;
    const text = new TextDecoder().decode(zettel.bytes);
    expect(text).toContain("TEST – NICHT VERSENDEN");
    expect(text).toContain("Anzahl Urbelege: 2");
    expect(text).toContain("Test-Belegannahme Podologie");
    expect(p.begleitzettel).toHaveLength(1);

    // zweiter Lauf: Nummern laufen weiter (über Dateien hinweg eindeutig)
    const p2 = erzeugeTestpaket(praxis(), [vo()], KOTR, JETZT, nummern);
    expect(p2.uebersicht[0]).toEqual(expect.objectContaining({ nutzdatei: "TSOL0001", rechnungsnummern: ["T2026-00002"] }));
    expect(nummern.stand).toEqual({ rechnung: { "2026": 2 }, transfer: 1, dar: { [TEST_IK.davMitEntschluesselung]: 2 } });
  });

  it("eVerordnung ohne Papierbeleg: kein Begleitzettel", () => {
    const p = erzeugeTestpaket(praxis(), [vo({ source: "everordnung", externalRef: "160.000.000.000.000.01" })], KOTR, JETZT, new Nummernkreis(leererZaehlerstand(), "T"));
    expect(p.dateien.some((d) => d.name.includes("Begleitzettel"))).toBe(false);
  });

  it("ohne abrechenbaren Fall oder mit Praxisfehler entsteht nichts und der Zähler bleibt", () => {
    const nummern = new Nummernkreis(leererZaehlerstand(), "T");
    expect(() => erzeugeTestpaket(praxis(), [vo({ verordnungsart: null })], KOTR, JETZT, nummern)).toThrow(/Kein Fall ist vollständig/);
    expect(() => erzeugeTestpaket(praxis({ tarifkennzeichen: "ABCDE" }), [vo()], KOTR, JETZT, nummern)).toThrow(/Tarifkennzeichen/);
    expect(nummern.stand).toEqual(leererZaehlerstand());
  });

  it("ZIP-tauglich und Begleitzettel-PDF", async () => {
    const p = erzeugeTestpaket(praxis(), [vo()], KOTR, JETZT, new Nummernkreis(leererZaehlerstand(), "T"));
    const pdf = await begleitzettelPdf(p.begleitzettel, { test: true });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    const zip = new JSZip();
    for (const d of p.dateien) zip.file(d.name, d.bytes);
    const wieder = await JSZip.loadAsync(await zip.generateAsync({ type: "uint8array" }));
    expect(Object.keys(wieder.files).some((n) => n.endsWith("TSOL0000.AUF"))).toBe(true);
  });
});

describe("Nummernkreis", () => {
  it("Rechnungsnummer je Jahr, Transfernummer 0–999, Datenaustauschreferenz 1–99999 mit Umlauf", () => {
    const k = new Nummernkreis({ rechnung: { "2026": 41 }, transfer: 999, dar: { "990030017": 99999 } }, "T");
    expect(k.rechnungsnummer("2026")).toBe("T2026-00042");
    expect(k.rechnungsnummer("2027")).toBe("T2027-00001");
    expect(k.transfernummer()).toBe(0);
    expect(k.datenaustauschreferenz("990030017")).toBe(1);
    expect(new Nummernkreis(leererZaehlerstand(), "").rechnungsnummer("2026")).toBe("2026-00001");
  });

  it("liest gespeicherte Stände robust", () => {
    expect(zaehlerstandAus(null)).toEqual(leererZaehlerstand());
    expect(zaehlerstandAus({ rechnung: { "2026": 3, x: "a", y: -1 }, transfer: "5", dar: [] })).toEqual({ rechnung: { "2026": 3 }, transfer: -1, dar: {} });
  });
});

describe("Review-Runde 2 Paket D", () => {
  /** zweite Kassenart: alle IKs der Testdatei an Stelle 3 auf „8“ umgeschlüsselt (gültige Prüfziffer) */
  const umschluesseln = (ik: string) => ikMitPruefziffer(`998${ik.slice(3, 8)}`);
  const iks = [...new Set(JSON.stringify(kotrDatei).match(/99\d{7}/g))];
  let json = JSON.stringify(kotrDatei);
  for (const ik of iks) json = json.split(`"${ik}"`).join(`"${umschluesseln(ik)}"`);
  const zweite: Kostentraegerdatei = JSON.parse(json);
  /** in der ersten Datei: zweite Kasse, die auf denselben Kostenträger verweist */
  const KASSE2 = ikMitPruefziffer("99002009");
  const erste: Kostentraegerdatei = structuredClone(kotrDatei);
  const vorlage = erste.institutionen.find((i) => i.ik === TEST_IK.kasse && i.verarbeitungskennzeichen === "01")!;
  erste.institutionen.push({ ...structuredClone(vorlage), ik: KASSE2, name: ["Testkasse Süd"] });
  const ZWEI: DaKotrDatei[] = [{ datei: erste, kassenart: "GK" }, { datei: zweite, kassenart: "AO" }];

  it("mehrere Datenannahmestellen/Kassenarten → mehrere TSOL-Dateien mit eigenen Transfernummern", () => {
    const nummern = new Nummernkreis(leererZaehlerstand(), "T");
    const p = erzeugeTestpaket(praxis(), [vo(), vo({ insurerIk: umschluesseln(TEST_IK.kasse) })], ZWEI, JETZT, nummern);
    expect(p.uebersicht.map((u) => [u.nutzdatei, u.kassenart, u.davIk])).toEqual([
      ["TSOL0000", "GK", TEST_IK.davMitEntschluesselung],
      ["TSOL0001", "AO", umschluesseln(TEST_IK.davMitEntschluesselung)],
    ]);
    expect(p.uebersicht.flatMap((u) => u.rechnungsnummern)).toEqual(["T2026-00001", "T2026-00002"]);
    expect(nummern.stand.dar).toEqual({ [TEST_IK.davMitEntschluesselung]: 1, [umschluesseln(TEST_IK.davMitEntschluesselung)]: 1 });
  });

  it("ein Kostenträger, mehrere Kassen-IKs → je eine Gesamtrechnung, Belegnummern je ab 1", () => {
    const p = erzeugeTestpaket(praxis(), [vo(), vo({ insurerIk: KASSE2 }), vo({ insurerIk: KASSE2 })], ZWEI, JETZT, new Nummernkreis(leererZaehlerstand(), "T"));
    expect(p.uebersicht).toHaveLength(1);
    expect(p.uebersicht[0].rechnungsnummern).toEqual(["T2026-00001", "T2026-00002"]);
    const segmente = zerlegeEdifact(ausLatin1(p.dateien.find((d) => d.name.endsWith("/TSOL0000"))!.bytes));
    // je SLLA (Gesamtrechnung) Belegnummern ab 1
    const belege: string[][] = [];
    for (const s of segmente) {
      if (s.kennung === "UNH" && s.elemente[1][0] === "SLLA") belege.push([]);
      if (s.kennung === "INV") belege[belege.length - 1].push(s.elemente[3][0]);
    }
    expect(belege).toEqual([["1"], ["1", "2"]]);
    expect(p.begleitzettel.map((z) => [z.kasse.ik, z.anzahlUrbelege])).toEqual([[TEST_IK.kasse, 1], [KASSE2, 2]]);
  });

  it("Kassenart nicht ermittelbar → fehlende Angabe statt Gruppe „??“", () => {
    const e = pruefeFaelle(praxis(), [vo()], [{ datei: kotrDatei, kassenart: "" }], JETZT.datum);
    expect(e.faelle[0].status).toBe("fehlend");
    expect(e.faelle[0].fehlendeAngaben).toContain("Kassenart nicht ermittelbar (Kostenträger in keiner hinterlegten Kostenträgerdatei mit gültigem Dateinamen).");
    expect(e.testpaketMoeglich).toBe(false);
  });

  it("mehr als 1000 Verordnungen: eigene Meldung, nicht unter Praxisdaten", () => {
    const viele = Array.from({ length: 1001 }, () => vo({ priceSnapshot: null }));
    const e = pruefeFaelle(praxis(), viele, KOTR, JETZT.datum);
    expect(e.praxisFehler).toEqual([]);
    expect(e.laufFehler).toEqual(["Mehr als 1000 Verordnungen in einem Lauf – bitte in kleineren Abrechnungsläufen prüfen (höchstens 1000)."]);
    expect(e.testpaketMoeglich).toBe(false);
  });

  it("TA1-Einzelprüfung entfällt bei Praxisfehlern → Hinweis am Fall", () => {
    const f = pruefeFaelle(praxis({ tarifkennzeichen: null }), [vo()], KOTR, JETZT.datum).faelle[0];
    expect(f.hinweise).toContain("TA1-Einzelprüfung nicht ausgeführt, weil die Praxisdaten unvollständig sind.");
  });
});

describe("GKV Paket C: Verordnungsart, Verordnungsbesonderheit und Genehmigung aus der Verordnung", () => {
  it("bestätigte Angaben gehen in ZHE und SKZ (Art B2); ohne Genehmigung kein SKZ", () => {
    const p = erzeugeTestpaket(
      praxis(),
      [vo({ verordnungsart: "04", verordnungsbesonderheit: "4", genehmigung: { kennzeichen: "G-2026/17", datum: "2026-09-01" } }), vo({}, { lastName: "Beispiel", firstName: "Max" })],
      KOTR,
      JETZT,
      new Nummernkreis(leererZaehlerstand(), "T"),
    );
    const nutz = p.dateien.find((d) => d.name.endsWith("/TSOL0000"))!;
    const segmente = zerlegeEdifact(ausLatin1(nutz.bytes));
    const skz = segmente.filter((s) => s.kennung === "SKZ");
    expect(skz).toHaveLength(1);
    expect(skz[0].elemente.map((e) => e[0])).toEqual(["G-2026/17", "20260901", "B2"]);
    const zhe = segmente.filter((s) => s.kennung === "ZHE").map((s) => s.elemente.map((e) => e[0]));
    // Kennzeichen Verordnungsart und Verordnungsbesonderheit stehen hintereinander im ZHE (TA1 5.5.3.3)
    const mitArt = zhe.find((z) => z.join("|").includes("04|4"));
    expect(mitArt).toBeTruthy();
    expect(zhe.some((z) => z.join("|").includes("03|"))).toBe(true);
  });

  it("unbekannte Verordnungsbesonderheit wird nicht übernommen (kein ungültiger Schlüssel in der Datei)", () => {
    const f = pruefeFaelle(praxis(), [vo({ verordnungsbesonderheit: "3" })], KOTR, JETZT.datum).faelle[0];
    expect(f.status).toBe("ok");
  });
});
