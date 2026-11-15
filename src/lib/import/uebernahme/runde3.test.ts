/**
 * Übernahme-Assistent, Review Runde 3 (AppSec SB1, Code-Review Nice, Buchhaltung BC): Unit-Tests ohne Datenbank.
 * Ausschließlich erfundene Daten.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { IMPORTED_RECEIPT_MARK } from "@/lib/invoice-labels";
import { receiptMark } from "@/lib/partial-lines";
import { legacyPatientNumber, MAX_LEGACY_PATIENT_ID, parseWorkbook } from "../excel/parse";
import { buildWorkbook } from "../excel/excel-import.test";
import { collectFiles, RUN_LIMITS } from "./collect";
import { analyzeFile } from "./detect";
import { buildPlan, choiceConflictsMessage, type ExistingSnapshot } from "./plan";
import { StoreTimeoutError, withTimeout } from "./run";
import type { DetectedFile } from "./types";
import { buildZip, DEFAULT_ZIP_LIMITS, newZipBudget, unzip, ZipError } from "./zip";

const enc = (s: string) => new TextEncoder().encode(s);
const NOW = new Date("2026-01-13T08:00:00Z");
const empty = (): ExistingSnapshot => ({ patients: [], appointmentRefs: new Set(), prescriptionRefs: new Set(), documentHashes: new Set(), therapists: [], locations: [], services: [] });
const TH = "patienten_id;nachname;versicherungstyp;telefon_1_label";
const TINANA_HEADER =
  "patienten_id;anrede;titel;vorname;nachname;geschlecht;geburtsdatum;strasse;hausnummer;plz;stadt;standort;email;telefon_1_label;telefon_1;telefon_2_label;telefon_2;notiz;vip;versicherungstyp;erstellt_am";
const tinanaRow = (id: string, first = "Erika", last = "Musterfrau", birth = "03.04.1950") => `${id};Frau;;${first};${last};Weiblich;${birth};;;;;;;;;;;;Nein;GKV;`;

/** ZIP mit `inner` inneren ZIPs à `per` Einträgen (AppSec-Gegenmessung nest2.mts) */
function nested(inner: number, per: number): Uint8Array {
  const inners = [];
  for (let z = 0; z < inner; z++) {
    const ent = [];
    for (let e = 0; e < per; e++) ent.push({ path: `${e}.csv`, data: `${TH}\nz${z}e${e};N${e};GKV;\n`, store: true });
    inners.push({ path: `i${z}.zip`, data: buildZip(ent) });
  }
  return buildZip(inners);
}

describe("AppSec Runde 3 SB1: Einträge über alle ZIPs eines Laufs begrenzt", () => {
  it("Regressionstest: 120 innere ZIPs × 2.000 Einträge werden in < 1 s abgelehnt", async () => {
    const bomb = nested(120, 2000);
    const t0 = performance.now();
    expect(() => unzip(bomb)).toThrow(ZipError);
    const tUnzip = performance.now() - t0;
    const t1 = performance.now();
    const detected = await collectFiles([{ name: "export.zip", data: bomb }]);
    const tCollect = performance.now() - t1;
    console.info(`[SB1] 120×2.000 verschachtelt (${(bomb.length / 1e6).toFixed(1)} MB): unzip ${Math.round(tUnzip)} ms, collectFiles ${Math.round(tCollect)} ms`);
    expect(tUnzip).toBeLessThan(1_000);
    expect(tCollect).toBeLessThan(1_000);
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ status: "rejected", label: "ZIP-Archiv" });
    expect(detected[0].note).toBe("Zu viele Dateien in einem Lauf (mehr als 5.000) – das ZIP wurde nicht gelesen. Bitte in mehreren Durchgängen hochladen.");
  }, 60_000);

  it("Grenze greift VOR dem Entpacken: Budget zählt Einträge, der erste Eintrag über der Grenze wird nicht mehr entpackt", () => {
    expect(DEFAULT_ZIP_LIMITS.maxRunEntries).toBe(RUN_LIMITS.maxFiles);
    const zip = buildZip(Array.from({ length: 5 }, (_, i) => ({ path: `p${i}.csv`, data: `x${i}` })));
    const budget = newZipBudget();
    expect(() => unzip(zip, { limits: { maxRunEntries: 4 }, budget })).toThrow(/Zu viele Dateien in einem Lauf \(mehr als 4\)/);
    // vier Einträge gezählt und entpackt, der fünfte nicht
    expect(budget.entries).toBe(4);
    expect(budget.usedBytes).toBe(8);
    // das Budget gilt über mehrere Archive desselben Laufs
    const two = buildZip([{ path: "a.csv", data: "a" }, { path: "b.csv", data: "b" }]);
    const run = newZipBudget();
    expect(unzip(two, { limits: { maxRunEntries: 3 }, budget: run })).toHaveLength(2);
    expect(() => unzip(two, { limits: { maxRunEntries: 3 }, budget: run })).toThrow(ZipError);
  });

  it("höchstens 50 innere ZIPs je Lauf (über alle Uploads)", async () => {
    expect(DEFAULT_ZIP_LIMITS.maxInnerZips).toBe(50);
    expect(() => unzip(nested(51, 1))).toThrow("Zu viele ZIP-Dateien im ZIP (mehr als 50 je Lauf) – bitte die Exporte direkt hochladen.");
    expect(unzip(nested(50, 1))).toHaveLength(50);
    // zwei Uploads à 30 innere ZIPs: der zweite wird abgelehnt
    const det = await collectFiles([
      { name: "a.zip", data: nested(30, 1) },
      { name: "b.zip", data: nested(30, 1) },
    ]);
    expect(det.find((d) => d.name === "b.zip")).toMatchObject({ status: "rejected", note: expect.stringMatching(/mehr als 50 je Lauf/) });
    expect(det.filter((d) => d.name.startsWith("a.zip/"))).toHaveLength(30);
  });
});

describe("Code-Review Runde 3 (Nice)", () => {
  it("Legacy-IDs über 9.999.999: Hinweis, ID bleibt als Bezug (Runde 4 R2: Nummernvergabe begrenzt, nicht die ID)", async () => {
    expect(MAX_LEGACY_PATIENT_ID).toBe(9_999_999);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook()) as never);
    const ws = wb.getWorksheet("Patienten")!;
    ws.getCell("A3").value = 12_345_678;
    const res = await parseWorkbook(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer), { today: "2026-11-07" });
    const max = res.patients.find((p) => p.row === 3)!;
    expect(max.legacyId).toBe(12_345_678);
    expect(legacyPatientNumber(max.legacyId)).toBeNull();
    expect(res.report.warnings).toContainEqual(
      expect.objectContaining({
        row: 3,
        message: "ID 12345678 ist zu groß für eine Patientennummer (höchstens 9.999.999) – neue Patientennummer wird vergeben, die ID bleibt als Bezug (Rechnungen, Gutscheine) erhalten.",
      }),
    );
    // genau an der Grenze bleibt die ID auch Nummer
    ws.getCell("A3").value = 9_999_999;
    const ok = await parseWorkbook(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer), { today: "2026-11-07" });
    expect(ok.patients.find((p) => p.row === 3)!.legacyId).toBe(9_999_999);
    expect(legacyPatientNumber(9_999_999)).toBe(9_999_999);
    expect(legacyPatientNumber(0)).toBeNull();
    expect(legacyPatientNumber(null)).toBeNull();
  });

  it("ChoiceConflictError-Text nennt alle Nummern", () => {
    expect(choiceConflictsMessage([{ key: "a", number: 7 }])).toBe("Nr. 7 kann nur einmal verknüpft werden, bitte erneut prüfen.");
    expect(choiceConflictsMessage([{ key: "a", number: 7 }, { key: "b", number: 9 }, { key: "c", number: 7 }, { key: "d", number: 12 }])).toBe(
      "Nr. 7, 9 und 12 können jeweils nur einmal verknüpft werden, bitte erneut prüfen.",
    );
  });

  it("Vorschau: Excel-Zeile MIT Legacy-ID und gleichnamige Tinana-Neuanlage → Hinweis (beide werden angelegt)", async () => {
    const res = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    const row = { ...res.patients[0], legacyId: 4711, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03" };
    const excel: DetectedFile = { name: "r.xlsx", sha256: "x", size: 1, kind: "podohero.excel", source: "podohero-excel", label: "Excel", target: "–", status: "import", records: 1, issues: [], excel: { ...res, patients: [row] } };
    const tinana = await analyzeFile("patients_export_2026-01-15.csv", enc([TINANA_HEADER, tinanaRow("t-1")].join("\n")));
    const plan = buildPlan([tinana, excel], empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.totals.patientsNew).toBe(1);
    expect(plan.totals.excel).toMatchObject({ patientsNew: 1, patientsExisting: 0 });
    expect(plan.warnings.map((w) => w.message)).toContain(
      "Excel: E. M. (Jg. 1950) (ID 4711) – gleiche Person (Name + Geburtsdatum) wird in diesem Lauf auch aus Tinana bzw. Doctolib neu angelegt. Beide Einträge werden übernommen; bitte prüfen Sie diese Personen nach der Übernahme und führen Sie Doppelte zusammen.",
    );
    // ohne gleichnamige Neuanlage kein Hinweis
    const alone = buildPlan([excel], empty(), { prescriptionMode: "billed", now: NOW });
    expect(alone.warnings.some((w) => w.message.includes("gleiche Person (Name + Geburtsdatum) wird in diesem Lauf"))).toBe(false);
  });

  it("AppSec H1: withTimeout bricht hängende Ablage ab, lässt schnelle durch", async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toBeInstanceOf(StoreTimeoutError);
    await expect(withTimeout(Promise.resolve("ok"), 1_000)).resolves.toBe("ok");
  });

  it("Runde 4 R3: withTimeout räumt ein erst nach der Zeitgrenze fertiges Ergebnis auf (onLate), sonst nicht", async () => {
    const late: string[] = [];
    let finish!: (v: string) => void;
    const slow = new Promise<string>((r) => (finish = r));
    await expect(withTimeout(slow, 10, (v) => late.push(v))).rejects.toBeInstanceOf(StoreTimeoutError);
    finish("spät");
    await new Promise((r) => setTimeout(r, 0));
    expect(late).toEqual(["spät"]);
    // rechtzeitig fertig: kein Aufräumen; verspätet abgelehnt bzw. Fehler beim Aufräumen: verschluckt
    await expect(withTimeout(Promise.resolve("ok"), 1_000, (v) => late.push(v))).resolves.toBe("ok");
    let fail!: (e: Error) => void;
    const failing = new Promise<string>((_, rej) => (fail = rej));
    await expect(withTimeout(failing, 10, () => late.push("nie"))).rejects.toBeInstanceOf(StoreTimeoutError);
    fail(new Error("Ablage gescheitert"));
    await expect(withTimeout(new Promise<string>((r) => setTimeout(() => r("x"), 20)), 5, () => Promise.reject(new Error("discard")))).rejects.toBeInstanceOf(StoreTimeoutError);
    await new Promise((r) => setTimeout(r, 40));
    expect(late).toEqual(["spät"]);
  });
});

describe("Buchhaltung Runde 3 BC", () => {
  it("übernommene Quittung wird in der Sammelrechnungs-Auswahl als „Altbestand“ gekennzeichnet", () => {
    expect(receiptMark({ source: "excel-import" })).toBe(IMPORTED_RECEIPT_MARK);
    expect(IMPORTED_RECEIPT_MARK).toBe("Altbestand");
    expect(receiptMark({ source: "crm" })).toBeNull();
    expect(receiptMark({})).toBeNull();
  });
});
