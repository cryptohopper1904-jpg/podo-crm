/**
 * AppSec Runde 2 A-B1 (Blocker): quadratische Laufzeit bei vielen gleichnamigen Zeilen. Regressionstest mit 50.000
 * gleichnamigen Tinana-Patient:innen (zwei Standort-Exporte à 25.000, gleiche Person, verschiedene IDs), dazu
 * 20.000 gleichnamige Doctolib-Zeilen ohne ID, 40.000 gleiche Verordnungszeilen und 5.000 gleichnamige Bestandspersonen.
 * Code-Review Runde 3 CS1: relative Prüfung statt fester Grenze (CI-Rechner sind unterschiedlich schnell) – ein Viertel
 * der Datenmenge (12.500 Tinana-Zeilen) gegen die volle (50.000): linear ≈ Faktor 4, quadratisch ≈ 16; verlangt wird
 * ein Verhältnis < 8. Dazu eine absolute Rückfallgrenze von 20 s und eine Aufwärmrunde (JIT). Ausschließlich erfundene Daten.
 */
import { describe, expect, it } from "vitest";
import { writeDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { collectFiles } from "./collect";
import { buildPlan, MAX_CANDIDATES, type ExistingPatient, type ExistingSnapshot } from "./plan";

const enc = (s: string) => new TextEncoder().encode(s);
const NOW = new Date("2026-01-13T08:00:00Z");
const TINANA_HEADER =
  "patienten_id;anrede;titel;vorname;nachname;geschlecht;geburtsdatum;strasse;hausnummer;plz;stadt;standort;email;telefon_1_label;telefon_1;telefon_2_label;telefon_2;notiz;vip;versicherungstyp;erstellt_am";
const RX_HEADER =
  "formulartyp;standort;ausstelldatum;patient_vorname;patient_nachname;patient_geburtsdatum;versichertennummer;krankenkasse;kostentraeger_id;arzt_titel;arzt_vorname;arzt_nachname;arztnummer;betriebsstaettennummer;diagnosegruppe;icd10_codes;behandlungseinheiten;heilmittel_positionsnummer;heilmittel_kuerzel;heilmittel_name;heilmittel_menge;heilmittel_preis;erstellt_am";

function tinanaPatients(from: number, n: number): string {
  const rows: string[] = [TINANA_HEADER];
  for (let i = from; i < from + n; i++) {
    rows.push(`p-${i};Frau;;Erika;Musterfrau;Weiblich;01.01.1950;Musterweg;1;12345;Musterstadt;Standort ${from};erika@example.invalid;Mobil;0151 0000001;;;;Nein;GKV;01.01.2026`);
  }
  return rows.join("\n");
}

function prescriptions(n: number): string {
  const rows: string[] = [RX_HEADER];
  const row = "Muster 13;Standort;10.01.2026;Erika;Musterfrau;01.01.1950;A000000000;Musterkasse;100000000;;Max;Arzt;000000000;000000000;UI1 – Unguis incarnatus;L60.0;6;78100;PBG;Podologische Behandlung;6;51.92;10.01.2026 09:00";
  for (let i = 0; i < n; i++) rows.push(row);
  return rows.join("\n");
}

function existingSnapshot(n: number): ExistingSnapshot {
  const patients: ExistingPatient[] = [];
  for (let i = 0; i < n; i++) {
    patients.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      number: i + 1,
      firstName: "Erika",
      lastName: "Musterfrau",
      // jede zehnte Person gelöscht (Art. 17) – mit anderem Geburtsdatum, sonst würde der Upload komplett geblockt
      birthDate: i % 10 === 0 ? "1960-01-01" : "1950-01-01",
      email: "erika@example.invalid",
      phoneMobile: "0151 0000001",
      externalIds: {},
      erased: i % 10 === 0,
    });
  }
  return { patients, appointmentRefs: new Set(), prescriptionRefs: new Set(), documentHashes: new Set(), therapists: [], locations: [], services: [] };
}

/** Upload und Bestand in der Größe `scale` (1 = 50.000 Tinana-, 20.000 Doctolib-, 40.000 Verordnungszeilen, 5.000 Bestand) */
function scenario(scale: number) {
  const n = (x: number) => Math.round(x * scale);
  const doctolib = writeDoctolibPatientsCsv(Array.from({ length: n(20_000) }, () => ({ lastName: "Musterfrau", firstName: "Erika", email: "erika@example.invalid" })), { delimiter: ",", bom: false });
  const files = [
    { name: "patients_export_2026-01-15.csv", data: enc(tinanaPatients(0, n(25_000))) },
    { name: "standort2/patients_export_2026-01-15.csv", data: enc(tinanaPatients(n(25_000), n(25_000))) },
    { name: "doctolib.csv", data: enc(doctolib) },
    { name: "prescriptions_export_2026-01-15.csv", data: enc(prescriptions(n(40_000))) },
  ];
  return { files, existing: existingSnapshot(n(5_000)) };
}

/** Erkennen + Parsen + Planen, Dauer in ms */
async function measure(scale: number) {
  const { files, existing } = scenario(scale);
  const t0 = performance.now();
  const detected = await collectFiles(files);
  const plan = buildPlan(detected, existing, { prescriptionMode: "billed", now: NOW });
  return { ms: performance.now() - t0, detected, plan };
}

describe("A-B1: lineare Laufzeit bei vielen gleichnamigen Zeilen", () => {
  it("12.500 vs. 50.000 gleichnamige Tinana-Zeilen (+ Doctolib, Verordnungen, Bestand): Verhältnis < 8, absolut < 20 s", async () => {
    await measure(0.05); // Aufwärmrunde
    const quarter = await measure(0.25);
    const full = await measure(1);
    const ratio = full.ms / quarter.ms;
    console.info(`[A-B1] 12.500 Zeilen: ${Math.round(quarter.ms)} ms, 50.000 Zeilen: ${Math.round(full.ms)} ms, Verhältnis ${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThan(8);
    expect(full.ms).toBeLessThan(20_000);

    const { detected, plan } = full;
    expect(detected.map((d) => d.status)).toEqual(["import", "import", "import", "import"]);
    // Tinana: 50.000 verschiedene IDs, jede wird angelegt bzw. verknüpft – Kandidaten je Entscheidung begrenzt
    expect(plan.totals.patientsNew + plan.totals.patientsLinked).toBeGreaterThanOrEqual(50_000);
    expect(plan.decisions.every((d) => d.candidates.length <= MAX_CANDIDATES)).toBe(true);
    // Verordnung: mehrere passende Personen im Upload → nicht übernommen
    expect(plan.totals.prescriptionsUnassigned).toBe(1);
    // Hinweis zu Upload-Dubletten nennt höchstens 10 Personen
    const dup = plan.warnings.find((w) => w.message.startsWith("Mögliche Dublette im Upload (Name + Geburtsdatum)"))!;
    expect(dup.message).toMatch(/und \d+ weitere/);
  }, 90_000);
});

/** Runde 4 R4: Tinana (n − 1) + Excel (n) gleichnamige Personen mit gleichem Geburtsdatum, Excel MIT Legacy-ID */
async function twinsScenario(n: number) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Patienten");
  ws.addRow(["ID", "Vorname", "Nachname", "Geburtsdatum"]);
  for (let i = 0; i < n; i++) ws.addRow([i + 1, "Erika", "Musterfrau", "01.01.1950"]);
  const xlsx = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  return [
    { name: "t/patients_export_2026-01-15.csv", data: enc(tinanaPatients(0, n - 1)) },
    { name: "podo.xlsx", data: xlsx },
  ];
}

async function measureTwins(n: number) {
  const files = await twinsScenario(n);
  const empty: ExistingSnapshot = { patients: [], appointmentRefs: new Set(), prescriptionRefs: new Set(), documentHashes: new Set(), therapists: [], locations: [], services: [] };
  const t0 = performance.now();
  const detected = await collectFiles(files);
  const plan = buildPlan(detected, empty, { prescriptionMode: "billed", now: NOW });
  return { ms: performance.now() - t0, plan };
}

describe("AppSec Runde 4 R4: Excel-Zwillings-Hinweis linear", () => {
  it("12.500 vs. 50.000 gleichnamige Excel-Zeilen (Tinana 49.999 gleichnamig): Verhältnis < 8, absolut < 20 s", async () => {
    await measureTwins(1_000); // Aufwärmrunde
    const quarter = await measureTwins(12_500);
    const full = await measureTwins(50_000);
    const ratio = full.ms / quarter.ms;
    console.info(`[R4] 12.500 Zeilen: ${Math.round(quarter.ms)} ms, 50.000 Zeilen: ${Math.round(full.ms)} ms, Verhältnis ${ratio.toFixed(2)}`);
    expect(ratio).toBeLessThan(8);
    expect(full.ms).toBeLessThan(20_000);
    expect(full.plan.patientsCreate).toHaveLength(49_999);
    expect(full.plan.warnings.find((w) => w.message.includes("gleiche Person (Name + Geburtsdatum) wird in diesem Lauf"))?.message).toMatch(/und 49990 weitere/);
  }, 120_000);
});
