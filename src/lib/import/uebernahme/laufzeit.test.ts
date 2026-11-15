/**
 * AppSec Runde 2 A-B1 (Blocker): quadratische Laufzeit bei vielen gleichnamigen Zeilen. Regressionstest mit 50.000
 * gleichnamigen Tinana-Patient:innen (zwei Standort-Exporte à 25.000, gleiche Person, verschiedene IDs), dazu
 * 20.000 gleichnamige Doctolib-Zeilen ohne ID, 40.000 gleiche Verordnungszeilen und 5.000 gleichnamige Bestandspersonen.
 * Erkennen, Parsen und Planen müssen deutlich unter 5 s bleiben. Ausschließlich erfundene Daten.
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

describe("A-B1: lineare Laufzeit bei vielen gleichnamigen Zeilen", () => {
  it("50.000 gleichnamige Tinana-Zeilen + 20.000 Doctolib-Zeilen + 40.000 Verordnungszeilen gegen 5.000 Bestandspersonen < 5 s", async () => {
    const doctolib = writeDoctolibPatientsCsv(Array.from({ length: 20_000 }, () => ({ lastName: "Musterfrau", firstName: "Erika", email: "erika@example.invalid" })), { delimiter: ",", bom: false });
    const files = [
      { name: "patients_export_2026-01-15.csv", data: enc(tinanaPatients(0, 25_000)) },
      { name: "standort2/patients_export_2026-01-15.csv", data: enc(tinanaPatients(25_000, 25_000)) },
      { name: "doctolib.csv", data: enc(doctolib) },
      { name: "prescriptions_export_2026-01-15.csv", data: enc(prescriptions(40_000)) },
    ];
    const existing = existingSnapshot(5_000);
    const t0 = performance.now();
    const detected = await collectFiles(files);
    console.info(`[A-B1] collect: ${Math.round(performance.now() - t0)} ms`);
    const plan = buildPlan(detected, existing, { prescriptionMode: "billed", now: NOW });
    const ms = performance.now() - t0;
    console.info(`[A-B1] Erkennen + Parsen + Planen: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(5_000);

    expect(detected.map((d) => d.status)).toEqual(["import", "import", "import", "import"]);
    // Tinana: 50.000 verschiedene IDs, jede wird angelegt bzw. verknüpft – Kandidaten je Entscheidung begrenzt
    expect(plan.totals.patientsNew + plan.totals.patientsLinked).toBeGreaterThanOrEqual(50_000);
    expect(plan.decisions.every((d) => d.candidates.length <= MAX_CANDIDATES)).toBe(true);
    // Verordnung: mehrere passende Personen im Upload → nicht übernommen
    expect(plan.totals.prescriptionsUnassigned).toBe(1);
    // Hinweis zu Upload-Dubletten nennt höchstens 10 Personen
    const dup = plan.warnings.find((w) => w.message.startsWith("Mögliche Dublette im Upload (Name + Geburtsdatum)"))!;
    expect(dup.message).toMatch(/und \d+ weitere/);
  }, 30_000);
});
